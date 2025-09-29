import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import axios from "axios";
import crypto from "crypto";
import WebSocket from "ws"; // 👈 añadimos WebSocket

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// === Firebase Admin con JSON completo en FIREBASE_SERVICE_ACCOUNT ===
try {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  console.log("✅ Firebase Admin inicializado con JSON completo");
} catch (err) {
  console.error("❌ Error inicializando Firebase Admin:", err);
}

const db = admin.firestore();

// === Healthcheck ===
app.get("/", (req, res) => {
  res.send("API JJXCAPITAL 🚀 funcionando con Firebase Admin");
});

// === Guardar mensaje de prueba ===
app.post("/save", async (req, res) => {
  try {
    const { mensaje } = req.body;
    if (!mensaje) {
      return res.status(400).json({ success: false, error: "El campo 'mensaje' es obligatorio" });
    }

    const docRef = await db.collection("mensajes").add({
      mensaje,
      fecha: new Date(),
    });

    res.json({ success: true, id: docRef.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Guardar operación manual dentro del UID ===
app.post("/save-operation", async (req, res) => {
  try {
    const { uid, order_id, exchange, operation_type, crypto: cryptoSymbol, fiat, crypto_amount, fiat_amount, exchange_rate, fee, profit } = req.body;

    if (!uid) {
      return res.status(400).json({ success: false, error: "Falta el UID del usuario" });
    }

    const operationData = {
      order_id: order_id || "",
      exchange,
      operation_type,
      crypto: cryptoSymbol,
      fiat,
      crypto_amount: parseFloat(crypto_amount) || 0,
      fiat_amount: parseFloat(fiat_amount) || 0,
      exchange_rate: parseFloat(exchange_rate),
      fee: parseFloat(fee) || 0,
      profit: parseFloat(profit) || 0,
      timestamp: new Date(),
    };

    const docRef = await db.collection("users").doc(uid).collection("operations").add(operationData);

    res.json({ success: true, id: docRef.id, data: operationData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === 🔥 WebSocket de Binance para órdenes en tiempo real ===
async function startUserStream(uid, apiKey, apiSecret) {
  try {
    // 1. Crear listenKey
    const listenResp = await axios.post("https://api.binance.com/api/v3/userDataStream", null, {
      headers: { "X-MBX-APIKEY": apiKey },
    });

    const listenKey = listenResp.data.listenKey;
    console.log(`🔑 ListenKey creado para ${uid}: ${listenKey}`);

    // 2. Conectar al WebSocket
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${listenKey}`);

    ws.on("open", () => console.log(`📡 WS abierto para ${uid}`));

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Solo nos interesan los reportes de órdenes
        if (data.e === "executionReport") {
          console.log("📥 Evento recibido:", data);

          const operationData = {
            order_id: data.i.toString(),
            exchange: "Binance",
            operation_type: data.S === "SELL" ? "Venta" : "Compra",
            crypto: data.s.replace("USDT", ""),
            fiat: "USDT",
            crypto_amount: parseFloat(data.l), // cantidad ejecutada
            fiat_amount: parseFloat(data.Z), // total acumulado en USDT
            exchange_rate: parseFloat(data.Z) / (parseFloat(data.l) || 1),
            fee: 0,
            profit: 0,
            timestamp: new Date(data.T),
          };

          await db.collection("users").doc(uid).collection("operations").doc(data.i.toString()).set(operationData);

          console.log(`✅ Orden guardada para ${uid}: ${data.i}`);
        }
      } catch (err) {
        console.error("❌ Error procesando evento WS:", err);
      }
    });

    ws.on("close", () => console.log(`❌ WS cerrado para ${uid}`));
    ws.on("error", (err) => console.error(`❌ Error WS para ${uid}:`, err));

    // 3. Renovar listenKey cada 30 minutos
    setInterval(async () => {
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
    }, 1000 * 60 * 30);
  } catch (err) {
    console.error("❌ Error iniciando userStream:", err.response?.data || err.message);
  }
}

// === Endpoint para conectar Binance ===
app.post("/connect-binance", async (req, res) => {
  try {
    const { uid, apiKey, apiSecret } = req.body;

    if (!uid || !apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: "Faltan uid, apiKey o apiSecret" });
    }

    // Guardamos las claves en Firestore (⚠️ solo ejemplo, mejor cifrar)
    await db.collection("users").doc(uid).set(
      {
        binanceApiKey: apiKey,
        binanceApiSecret: apiSecret,
        binanceConnected: true,
      },
      { merge: true }
    );

    // Inicia el WebSocket para ese usuario
    startUserStream(uid, apiKey, apiSecret);

    res.json({ success: true, message: "Binance conectado ✅" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Servidor ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));