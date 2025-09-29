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

// === Firebase Admin ===
try {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  console.log("✅ Firebase Admin inicializado");
} catch (err) {
  console.error("❌ Error inicializando Firebase Admin:", err);
}
const db = admin.firestore();

// === Cifrado opcional (AES-256-GCM) ===
const ENCRYPTION_KEY_BASE64 = process.env.ENCRYPTION_KEY || null;
let ENCRYPTION_KEY = null;
if (ENCRYPTION_KEY_BASE64) {
  ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_BASE64, "base64");
  if (ENCRYPTION_KEY.length !== 32) {
    console.warn("⚠️ ENCRYPTION_KEY debe ser 32 bytes (base64). Se desactiva cifrado.");
    ENCRYPTION_KEY = null;
  }
}
const encrypt = (plainText) => {
  if (!ENCRYPTION_KEY) return plainText;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
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
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return payload;
  }
};

// === Map de streams activos ===
const streams = {};

// === Start Stream ===
async function startUserStream(uid, apiKey, apiSecretPlain) {
  try {
    if (streams[uid]) stopUserStream(uid);

    const listenResp = await axios.post(
      "https://api.binance.com/api/v3/userDataStream",
      null,
      { headers: { "X-MBX-APIKEY": apiKey } }
    );
    const listenKey = listenResp.data?.listenKey;
    if (!listenKey) throw new Error("No listenKey");

    console.log(`🔑 ListenKey creado para ${uid}`);

    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${listenKey}`);

    ws.on("open", () => console.log(`📡 WS abierto para ${uid}`));
    ws.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.e === "executionReport") {
          const orderId = data.i?.toString?.() || `${Date.now()}`;
          const executedQty = parseFloat(data.l || "0");
          const cumQuote = parseFloat(data.Z || "0");
          const op = {
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
            timestamp: new Date(data.T || Date.now()),
            raw: data,
          };
          await db.collection("users").doc(uid).collection("operations").doc(orderId).set(op, { merge: true });
          console.log(`✅ Orden guardada ${uid}:${orderId}`);
        }
      } catch (err) {
        console.error("❌ Error WS msg:", err);
      }
    });
    ws.on("close", () => stopUserStream(uid));
    ws.on("error", (err) => console.error(`❌ WS error ${uid}:`, err.message));

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
    }, 1000 * 60 * 30);

    streams[uid] = { ws, renewIntervalId, listenKey };
    await db.collection("users").doc(uid).set({ lastListenKey: listenKey, lastListenKeyAt: new Date() }, { merge: true });
  } catch (err) {
    console.error(`❌ startUserStream ${uid}:`, err.message);
  }
}
function stopUserStream(uid) {
  const s = streams[uid];
  if (!s) return;
  try { s.ws?.close(); } catch {}
  try { clearInterval(s.renewIntervalId); } catch {}
  delete streams[uid];
  console.log(`🛑 Stream detenido para ${uid}`);
}

// === Endpoints ===
app.post("/connect-binance", async (req, res) => {
  try {
    const { uid, apiKey, apiSecret } = req.body;
    if (!uid || !apiKey || !apiSecret) return res.status(400).json({ success: false, error: "Faltan campos" });

    await db.collection("users").doc(uid).set({
      binanceApiKey: apiKey,
      binanceApiSecret: encrypt(apiSecret),
      binanceConnected: true,
      binanceConnectedAt: new Date(),
    }, { merge: true });

    await startUserStream(uid, apiKey, apiSecret);
    res.json({ success: true, message: "Binance conectado ✅" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Alias: verify-binance-keys → connect-binance
app.post("/api/verify-binance-keys", async (req, res) => {
  try {
    const { uid, apiKey, apiSecret } = req.body;
    if (!uid || !apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: "Faltan uid, apiKey o apiSecret" });
    }

    await db.collection("users").doc(uid).set({
      binanceApiKey: apiKey,
      binanceApiSecret: encrypt(apiSecret),
      binanceConnected: true,
      binanceConnectedAt: new Date(),
    }, { merge: true });

    await startUserStream(uid, apiKey, apiSecret);

    res.json({ success: true, message: "Binance conectado y verificado ✅" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/disconnect-binance", async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ success: false, error: "Falta uid" });

    stopUserStream(uid);
    await db.collection("users").doc(uid).set({ binanceConnected: false, binanceDisconnectedAt: new Date() }, { merge: true });

    res.json({ success: true, message: "Binance desconectado ❌" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Boot: reinicia streams previos ===
async function startAllUserStreamsOnBoot() {
  const qSnap = await db.collection("users").where("binanceConnected", "==", true).get();
  qSnap.forEach((docSnap) => {
    const d = docSnap.data();
    if (!d.binanceApiKey || !d.binanceApiSecret) return;
    const secret = decrypt(d.binanceApiSecret);
    startUserStream(docSnap.id, d.binanceApiKey, secret);
  });
}

// === Health ===
app.get("/", (req, res) => res.send("API JJXCAPITAL 🚀 online"));
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Backend en Railway funcionando ✅" });
});

// === Start server ===
const PORT = process.env.PORT; // Railway asigna el puerto
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
  startAllUserStreamsOnBoot();
});