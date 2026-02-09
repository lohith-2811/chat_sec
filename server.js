require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");

/* ---------------- BASIC SETUP ---------------- */

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

/* ---------------- MONGODB ---------------- */

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(() => console.log("MongoDB Connection Error"));

/* ---------------- MESSAGE SCHEMA ---------------- */

const messageSchema = new mongoose.Schema({
  roomId: String,
  payload: Object, 
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

const Message = mongoose.model("Message", messageSchema);

/* ---------------- SOCKET LOGIC ---------------- */

io.on("connection", (socket) => {

  socket.on("join-room", async (roomId) => {
    socket.join(roomId);

    // send encrypted previous messages
    const messages = await Message.find({ roomId })
      .sort({ createdAt: 1 });

    socket.emit("previous-messages", messages);
  });

  socket.on("send-message", async ({ roomId, payload }) => {
    // payload is encrypted — server cannot read it (Zero-Knowledge)
    const msg = await Message.create({
      roomId,
      payload
    });

    // CRITICAL FIX: Broadcast to ALL clients in the room (io.to(roomId))
    // This ensures the sender gets the MongoDB _id for deletion purposes.
    io.to(roomId).emit("receive-message", msg);
  });

  // --- DELETE MESSAGE LOGIC ---
  socket.on("delete-messages", async ({ roomId, messageIds }) => {
    if (!messageIds || messageIds.length === 0) return;

    try {
      // Convert string IDs back to Mongoose ObjectId format for the query
      // This is a common point of failure if not done correctly.
      const objectIds = messageIds.map(id => new mongoose.Types.ObjectId(id));
      
      const result = await Message.deleteMany({
        _id: { $in: objectIds },
        roomId: roomId 
      });

      if (result.deletedCount > 0) {
        console.log(`Deleted ${result.deletedCount} messages in room ${roomId}.`);
        
        // Broadcast the IDs of the deleted messages to all clients in the room
        io.to(roomId).emit("messages-deleted", { messageIds });
      }

    } catch (error) {
      console.error("Error deleting messages:", error);
    }
  });

});

/* ---------------- START SERVER ---------------- */

server.listen(process.env.PORT, () => {
  console.log(`Secure server running on port ${process.env.PORT}`);
});