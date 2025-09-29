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

// === Firebase Admin ===
try {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  console.log("✅ Firebase Admin inicializado");
} catch (err) {
  console.error("❌ Error inicializando Firebase Admin:", err);
}

const db = admin.firestore();
const ENC_SECRET = crypto
  .createHash("sha256")
  .update(process.env.ENCRYPTION_SECRET)
  .digest();

// === Funciones de cifrado/descifrado ===
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_SECRET, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return { encrypted, iv: iv.toString("hex"), authTag };
}

function decrypt(encrypted, ivHex, authTagHex) {
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_SECRET, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// === Healthcheck ===
app.get("/", (req, res) => res.send("API JJXCAPITAL 🚀 funcionando"));

// === Guardar operación manual ===
app.post("/save-operation", async (req, res) => {
  try {
    const { uid, ...operation } = req.body;
    if (!uid) return res.status(400).json({ success: false, error: "Falta UID" });

    const docRef = await db.collection("users").doc(uid).collection("operations").add({
      ...operation,
      timestamp: new Date(),
    });

    res.json({ success: true, id: docRef.id, data: operation });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === WS Binance ===
async function startUserStream(uid) {
  try {
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return console.error(`❌ Usuario ${uid} no encontrado`);

    const { apiKey, apiSecret } = userDoc.data().binanceKeys || {};
    if (!apiKey || !apiSecret) return console.error(`❌ No hay claves para ${uid}`);

    // Descifrar claves
    const decApiKey = decrypt(apiKey.encrypted, apiKey.iv, apiKey.authTag);
    const decApiSecret = decrypt(apiSecret.encrypted, apiSecret.iv, apiSecret.authTag);

    // Crear listenKey
    const listenResp = await axios.post("https://api.binance.com/api/v3/userDataStream", null, {
      headers: { "X-MBX-APIKEY": decApiKey },
    });
    const listenKey = listenResp.data.listenKey;
    console.log(`🔑 ListenKey creado para ${uid}`);

    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${listenKey}`);
    ws.on("open", () => console.log(`📡 WS abierto para ${uid}`));

    ws.on("message", async (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.e === "executionReport") {
        const op = {
          order_id: data.i.toString(),
          exchange: "Binance",
          operation_type: data.S === "SELL" ? "Venta" : "Compra",
          crypto: data.s.replace("USDT", ""),
          fiat: "USDT",
          crypto_amount: parseFloat(data.l),
          fiat_amount: parseFloat(data.Z),
          exchange_rate: parseFloat(data.Z) / (parseFloat(data.l) || 1),
          fee: 0,
          profit: 0,
          timestamp: new Date(data.T),
        };
        await db.collection("users").doc(uid).collection("operations").doc(data.i.toString()).set(op);
        console.log(`✅ Orden guardada para ${uid}: ${data.i}`);
      }
    });

    // Mantener vivo listenKey
    setInterval(async () => {
      await axios.put(`https://api.binance.com/api/v3/userDataStream?listenKey=${listenKey}`, null, {
        headers: { "X-MBX-APIKEY": decApiKey },
      });
      console.log(`🔄 ListenKey renovado para ${uid}`);
    }, 1000 * 60 * 30);
  } catch (err) {
    console.error("❌ Error en WS:", err.response?.data || err.message);
  }
}

// === Conectar Binance (cifrado) ===
app.post("/connect-binance", async (req, res) => {
  try {
    const { uid, apiKey, apiSecret } = req.body;
    if (!uid || !apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: "Faltan datos" });
    }

    const encApiKey = encrypt(apiKey);
    const encApiSecret = encrypt(apiSecret);

    await db.collection("users").doc(uid).set(
      {
        binanceKeys: {
          apiKey: encApiKey,
          apiSecret: encApiSecret,
        },
        binanceConnected: true,
      },
      { merge: true }
    );

    startUserStream(uid);

    res.json({ success: true, message: "Binance conectado ✅ (cifrado)" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Servidor ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));