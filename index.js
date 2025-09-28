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

// === Firebase Admin (credenciales de servicio) ===
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

// 🔹 Ruta raíz para Railway (healthcheck)
app.get("/", (req, res) => {
  res.send("API JJXCAPITAL 🚀 funcionando con Firebase Admin");
});

// ✅ Ruta de prueba
app.get("/ping", (req, res) => {
  res.json({ status: "Servidor activo ✅" });
});

// 🔹 Ruta test Firebase
app.post("/save", async (req, res) => {
  try {
    const { mensaje } = req.body;

    if (!mensaje) {
      return res
        .status(400)
        .json({ success: false, error: "El campo 'mensaje' es obligatorio" });
    }

    const docRef = await db.collection("mensajes").add({
      mensaje,
      fecha: new Date(),
    });

    res.json({ success: true, id: docRef.id });
  } catch (err) {
    console.error("❌ Error Firebase Admin:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Ruta Binance Spot (axios directo) ===
app.get("/balance", async (req, res) => {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac("sha256", process.env.BINANCE_API_SECRET)
      .update(queryString)
      .digest("hex");

    const response = await axios.get(
      `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
      {
        headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY },
      }
    );

    const balances = response.data.balances.filter(
      (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
    );

    res.json(balances);
  } catch (err) {
    console.error("❌ Error Binance axios:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// === Ruta para guardar operaciones manuales ===
app.post("/save-operation", async (req, res) => {
  try {
    const {
      order_id,
      exchange,
      operation_type,
      crypto: cryptoSymbol,
      fiat,
      crypto_amount,
      fiat_amount,
      exchange_rate,
      fee,
      profit,
    } = req.body;

    if (!exchange || !operation_type || !cryptoSymbol || !fiat || !exchange_rate) {
      return res.status(400).json({
        success: false,
        error:
          "Faltan campos obligatorios: exchange, operation_type, crypto, fiat, exchange_rate",
      });
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

    const docRef = await db.collection("operations").add(operationData);

    res.json({ success: true, id: docRef.id, data: operationData });
  } catch (err) {
    console.error("❌ Error guardando operación:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Ruta para sincronizar órdenes Spot automáticamente ===
app.get("/sync-operations", async (req, res) => {
  try {
    const timestamp = Date.now();
    const queryString = `symbol=BTCUSDT&timestamp=${timestamp}`; // 🔹 Cambia aquí el par si quieres otro
    const signature = crypto
      .createHmac("sha256", process.env.BINANCE_API_SECRET)
      .update(queryString)
      .digest("hex");

    const response = await axios.get(
      `https://api.binance.com/api/v3/allOrders?${queryString}&signature=${signature}`,
      {
        headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY },
      }
    );

    const orders = response.data;

    if (!orders || orders.length === 0) {
      return res.json({
        success: true,
        message: "No hay órdenes en Binance para este par.",
      });
    }

    const batch = db.batch();

    orders.forEach((order) => {
      const ref = db.collection("operations").doc();

      const operationData = {
        order_id: order.orderId.toString(),
        exchange: "Binance",
        operation_type: order.side === "SELL" ? "Venta" : "Compra",
        crypto: order.symbol.replace("USDT", ""), // Ejemplo: BTCUSDT → BTC
        fiat: "USDT",
        crypto_amount: parseFloat(order.executedQty),
        fiat_amount: parseFloat(order.cummulativeQuoteQty),
        exchange_rate:
          parseFloat(order.cummulativeQuoteQty) /
          (parseFloat(order.executedQty) || 1),
        fee: 0,
        profit: 0,
        timestamp: new Date(order.time),
      };

      batch.set(ref, operationData);
    });

    await batch.commit();

    res.json({ success: true, count: orders.length });
  } catch (err) {
    console.error("❌ Error en sync-operations:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// === Servidor ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`Servidor corriendo en puerto ${PORT}`)
);