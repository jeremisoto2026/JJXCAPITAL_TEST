// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import axios from "axios";
import crypto from "crypto";
import WebSocket from "ws";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

/**
 * Init Firebase Admin (desde JSON completo en env FIREBASE_SERVICE_ACCOUNT).
 * Si no lo tienes, puedes construir el objeto a partir de variables separadas.
 */
try {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  console.log("✅ Firebase Admin inicializado");
} catch (err) {
  console.error("❌ Error inicializando Firebase Admin:", err);
  // No hacemos process.exit para que el servidor siga corriendo y el error sea visible.
}

const db = admin.firestore();

/**
 * Opcional: cifrado AES-256-GCM para guardar apiSecret en Firestore.
 * - SETEA EN .env ENCRYPTION_KEY con una base64 de 32 bytes (ej. crypto.randomBytes(32).toString('base64')).
 * - Si no se define ENCRYPTION_KEY, guardamos el secret en texto plano (NO recomendado en producción).
 */
const ENCRYPTION_KEY_BASE64 = process.env.ENCRYPTION_KEY || null;
let ENCRYPTION_KEY = null;
if (ENCRYPTION_KEY_BASE64) {
  ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_BASE64, "base64");
  if (ENCRYPTION_KEY.length !== 32) {
    console.warn("⚠️ ENCRYPTION_KEY debe ser 32 bytes (base64). El cifrado no funcionará correctamente.");
    ENCRYPTION_KEY = null;
  }
}

const encrypt = (plainText) => {
  if (!ENCRYPTION_KEY) return plainText;
  const iv = crypto.randomBytes(12); // 96 bits recommended for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Guardamos iv + tag + ciphertext (base64)
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
};

const decrypt = (payload) => {
  if (!ENCRYPTION_KEY) return payload;
  try {
    const full = Buffer.from(payload, "base64");
    const iv = full.slice(0, 12);
    const tag = full.slice(12, 28);
    const encrypted = full.slice(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return dec;
  } catch (err) {
    console.error("❌ Error decrypt:", err);
    // Si falla, devolvemos el original por compatibilidad (posible que esté en texto plano)
    return payload;
  }
};

/**
 * Map para manejar streams activos en memoria:
 * streams[uid] = { ws, renewIntervalId, listenKey }
 */
const streams = {};

/**
 * startUserStream
 * - Crea listenKey REST
 * - Abre WS en wss://stream.binance.com:9443/ws/{listenKey}
 * - Guarda executionReport como documento en users/{uid}/operations/{orderId}
 * - Renueva listenKey cada 30 minutos
 */
async function startUserStream(uid, apiKey, apiSecretPlain) {
  try {
    // Si ya existe un stream para el uid, lo reiniciamos
    if (streams[uid]) {
      console.log(`♻️ Stream existente para ${uid} — cerrando y reiniciando`);
      stopUserStream(uid);
    }

    // 1) Crear listenKey
    const listenResp = await axios.post(
      "https://api.binance.com/api/v3/userDataStream",
      null,
      { headers: { "X-MBX-APIKEY": apiKey } }
    );

    const listenKey = listenResp.data?.listenKey;
    if (!listenKey) throw new Error("No se obtuvo listenKey desde Binance");

    console.log(`🔑 ListenKey creado para ${uid}: ${listenKey}`);

    // 2) Abrir WebSocket
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${listenKey}`);

    ws.on("open", () => {
      console.log(`📡 WS abierto para ${uid}`);
    });

    ws.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg.toString());

        // Filtramos executionReport (evento de orden)
        if (data.e === "executionReport") {
          // Construimos objeto de operación (ajusta campos según lo que necesites)
          const orderId = data.i?.toString?.() || `${Date.now()}`;
          const executedQty = parseFloat(data.l || data.q || "0"); // cantidad ejecutada
          const cumQuote = parseFloat(data.Z || data.z || "0"); // acumulado en quote asset
          const timestamp = data.T ? new Date(data.T) : new Date();

          const operationData = {
            order_id: orderId,
            exchange: "Binance",
            operation_type: data.S === "SELL" ? "Venta" : "Compra",
            crypto: (data.s || "").replace(/USDT$/i, ""),
            fiat: "USDT",
            crypto_amount: executedQty,
            fiat_amount: cumQuote,
            exchange_rate: cumQuote / (executedQty || 1),
            fee: 0,
            profit: 0,
            raw: data, // opcional: almacenar raw para depuración
            timestamp: timestamp,
          };

          // Guardamos en Firestore: users/{uid}/operations/{orderId}
          await db
            .collection("users")
            .doc(uid)
            .collection("operations")
            .doc(orderId)
            .set(operationData, { merge: true });

          console.log(`✅ Orden guardada para ${uid}: ${orderId}`);
        }
      } catch (err) {
        console.error("❌ Error procesando mensaje WS:", err);
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`❌ WS cerrado para ${uid} — code:${code} reason:${reason}`);
      // Limpiamos recursos si se cerró
      stopUserStream(uid);
    });

    ws.on("error", (err) => {
      console.error(`❌ Error WS para ${uid}:`, err && err.message ? err.message : err);
    });

    // 3) Renovar listenKey cada 30 minutos (put /userDataStream)
    const renewIntervalId = setInterval(async () => {
      try {
        await axios.put(
          `https://api.binance.com/api/v3/userDataStream?listenKey=${listenKey}`,
          null,
          { headers: { "X-MBX-APIKEY": apiKey } }
        );
        console.log(`🔄 ListenKey renovado para ${uid}`);
      } catch (err) {
        console.error("❌ Error renovando listenKey:", err.response?.data || err.message);
      }
    }, 1000 * 60 * 30); // 30 minutos

    // Guardamos en memoria
    streams[uid] = { ws, renewIntervalId, listenKey };

    // Guardamos listenKey + timestamp en Firestore (opcional, para seguimiento)
    await db
      .collection("users")
      .doc(uid)
      .set(
        {
          lastListenKey: listenKey,
          lastListenKeyAt: new Date(),
        },
        { merge: true }
      );
  } catch (err) {
    console.error("❌ Error iniciando userStream para", uid, err.response?.data || err.message || err);
    // No rethrowamos para no cortar el server
  }
}

function stopUserStream(uid) {
  const s = streams[uid];
  if (!s) return;
  try {
    if (s.ws && s.ws.readyState === WebSocket.OPEN) {
      s.ws.close();
    }
  } catch (err) {
    console.warn("⚠️ Error cerrando WS:", err);
  }
  try {
    clearInterval(s.renewIntervalId);
  } catch (err) {
    /* ignore */
  }
  delete streams[uid];
  console.log(`🛑 Stream detenido para ${uid}`);
}

/**
 * Endpoint: Conectar Binance (guarda claves y arranca el stream)
 * Body: { uid, apiKey, apiSecret }
 */
app.post("/connect-binance", async (req, res) => {
  try {
    const { uid, apiKey, apiSecret } = req.body;
    if (!uid || !apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: "Faltan uid, apiKey o apiSecret" });
    }

    // Guardamos (cifrado opcional)
    await db.collection("users").doc(uid).set(
      {
        binanceApiKey: apiKey,
        binanceApiSecret: encrypt(apiSecret),
        binanceConnected: true,
        binanceConnectedAt: new Date(),
      },
      { merge: true }
    );

    // Arrancamos el WS para este usuario (debe usar secret desencriptado internamente)
    const secretPlain = decrypt(encrypt(apiSecret)); // Si ENCRYPTION_KEY no existe, devuelve igual
    await startUserStream(uid, apiKey, secretPlain);

    return res.json({ success: true, message: "Binance conectado y stream iniciado ✅" });
  } catch (err) {
    console.error("❌ /connect-binance error:", err);
    return res.status(500).json({ success: false, error: err.message || err });
  }
});

/**
 * Endpoint: Desconectar Binance y detener stream
 * Body: { uid }
 */
app.post("/disconnect-binance", async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ success: false, error: "Falta uid" });

    // Detenemos stream en memoria
    stopUserStream(uid);

    // Actualizamos Firestore
    await db.collection("users").doc(uid).set(
      {
        binanceConnected: false,
        binanceDisconnectedAt: new Date(),
      },
      { merge: true }
    );

    return res.json({ success: true, message: "Binance desconectado y stream detenido" });
  } catch (err) {
    console.error("❌ /disconnect-binance error:", err);
    return res.status(500).json({ success: false, error: err.message || err });
  }
});

/**
 * Reiniciar streams al arrancar el servidor para usuarios que ya estaban conectados.
 * Busca documentos users donde binanceConnected == true y tiene binanceApiKey.
 */
async function startAllUserStreamsOnBoot() {
  try {
    const qSnap = await db.collection("users").where("binanceConnected", "==", true).get();
    if (qSnap.empty) {
      console.log("ℹ️ No hay usuarios con binanceConnected: true al iniciar");
      return;
    }
    console.log(`🔁 Reiniciando streams para ${qSnap.size} usuarios...`);
    qSnap.forEach((doc) => {
      const data = doc.data();
      const apiKey = data.binanceApiKey;
      const apiSecretStored = data.binanceApiSecret; // podría estar cifrado
      if (!apiKey || !apiSecretStored) {
        console.warn(`⚠️ Usuario ${doc.id} marca binanceConnected true pero faltan claves`);
        return;
      }
      const secretPlain = decrypt(apiSecretStored);
      startUserStream(doc.id, apiKey, secretPlain);
    });
  } catch (err) {
    console.error("❌ Error arrancando streams en boot:", err);
  }
}

/**
 * Health / test
 */
app.get("/", (req, res) => {
  res.send("API JJXCAPITAL 🚀 funcionando con Firebase Admin + Binance WS");
});

/**
 * Start server y luego arrancar streams existentes
 */
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  // Intentamos reiniciar streams existentes (no bloqueante)
  startAllUserStreamsOnBoot().catch((e) => console.error(e));
});