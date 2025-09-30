// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import axios from "axios";
import crypto from "crypto";

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

// === Función: traer órdenes P2P ===
async function fetchP2POrders(uid, apiKey, apiSecret) {
  try {
    const query = {
      page: 1,
      rows: 20, // trae las últimas 20
    };

    const resp = await axios.post(
      "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/order/query",
      query,
      {
        headers: {
          "X-MBX-APIKEY": apiKey,
          "Content-Type": "application/json"
        }
      }
    );

    const orders = resp.data?.data || [];
    for (const ord of orders) {
      const op = {
        order_id: ord.orderNumber.toString(),
        exchange: "Binance",
        operation_type: ord.tradeType === "SELL" ? "Venta" : "Compra",
        crypto: ord.asset,
        fiat: ord.fiat,
        crypto_amount: parseFloat(ord.amount),
        fiat_amount: parseFloat(ord.totalPrice),
        exchange_rate: parseFloat(ord.price),
        fee: 0,
        profit: 0,
        timestamp: new Date(ord.createTime),
        raw: ord,
      };

      await db
        .collection("users")
        .doc(uid)
        .collection("operations")
        .doc(op.order_id)
        .set(op, { merge: true });
    }

    console.log(`✅ Órdenes P2P actualizadas para ${uid}`);
  } catch (err) {
    console.error("❌ Error fetchP2POrders:", err.response?.data || err.message);
  }
}

// === CRON: cada 1 min actualiza órdenes P2P de todos los usuarios ===
setInterval(async () => {
  const qSnap = await db.collection("users").where("binanceConnected", "==", true).get();
  qSnap.forEach(async (docSnap) => {
    const d = docSnap.data();
    if (!d.binanceApiKey || !d.binanceApiSecret) return;
    const secret = decrypt(d.binanceApiSecret);
    await fetchP2POrders(docSnap.id, d.binanceApiKey, secret);
  });
}, 1000 * 60); // cada 1 min

// === Endpoints ===

// Conectar Binance
app.post("/api/connect-binance", async (req, res) => {
  try {
    const { uid, apiKey, apiSecret } = req.body;
    if (!uid || !apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: "Faltan campos" });
    }

    await db.collection("users").doc(uid).set({
      binanceApiKey: apiKey,
      binanceApiSecret: encrypt(apiSecret),
      binanceConnected: true,
      binanceConnectedAt: new Date(),
    }, { merge: true });

    res.json({ success: true, message: "Binance conectado ✅" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Desconectar Binance
app.post("/api/disconnect-binance", async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ success: false, error: "Falta uid" });

    await db.collection("users").doc(uid).set({
      binanceConnected: false,
      binanceApiKey: admin.firestore.FieldValue.delete(),
      binanceApiSecret: admin.firestore.FieldValue.delete(),
      binanceDisconnectedAt: new Date(),
    }, { merge: true });

    res.json({ success: true, message: "Binance desconectado y claves eliminadas ❌" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Health ===
app.get("/", (req, res) => res.send("API JJXCAPITAL 🚀 online"));
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Backend funcionando ✅" });
});

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});