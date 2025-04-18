// server.ts - Backend for Collaborative BigTextBox using Bun
import type { Server, ServerWebSocket } from 'bun';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

// Simple in-memory storage for development
// For production, use a proper database
const textBoxes: Record<string, { text: string, lastUpdated: number }> = {};

// Define socket connections
const connectedClients: Record<string, Set<ServerWebSocket<unknown>>> = {};

// Serve static files
const publicPath = path.join(import.meta.dir, 'public');

// Helper to send updates to all connected clients in a room
function broadcastToRoom(boxId: string, data: any, excludeWebSocket?: ServerWebSocket<unknown>) {
  if (!connectedClients[boxId]) return;
  
  for (const ws of connectedClients[boxId]) {
    if (ws !== excludeWebSocket && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}

// HTTP Server
const server: Server = Bun.serve({
  port: process.env.PORT || 3000,
  websocket: {
    message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        
        // Handle joining a room
        if (data.type === 'join') {
          const currentBoxId = data.boxId;
          
          if (!connectedClients[currentBoxId]) {
            connectedClients[currentBoxId] = new Set();
          }
          
          connectedClients[currentBoxId].add(ws);
          
          // Send current user count
          broadcastToRoom(currentBoxId, {
            type: 'userCount',
            count: connectedClients[currentBoxId].size
          });
          
        // Handle text updates
        } else if (data.type === 'textUpdate') {
          const currentBoxId = Object.keys(connectedClients).find(boxId => 
            connectedClients[boxId].has(ws)
          );
          
          if (currentBoxId && textBoxes[currentBoxId]) {
            textBoxes[currentBoxId].text = data.text;
            textBoxes[currentBoxId].lastUpdated = Date.now();
            
            // Broadcast to all clients except sender
            broadcastToRoom(currentBoxId, {
              type: 'textUpdate',
              text: data.text
            }, ws);
          }
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    },
    close(ws) {
      const currentBoxId = Object.keys(connectedClients).find(boxId => 
        connectedClients[boxId].has(ws)
      );
      
      if (currentBoxId && connectedClients[currentBoxId]) {
        connectedClients[currentBoxId].delete(ws);
        
        // Send updated user count
        broadcastToRoom(currentBoxId, {
          type: 'userCount',
          count: connectedClients[currentBoxId].size
        });
        
        // Clean up empty rooms
        if (connectedClients[currentBoxId].size === 0) {
          delete connectedClients[currentBoxId];
        }
      }
    }
  },
  fetch(req, server): Response | undefined {
    const url = new URL(req.url);
    
    // Handle WebSocket upgrade for all connections
    if (req.headers.get("Upgrade") === "websocket") {
      const upgraded = server.upgrade(req);
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    
    // API routes
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/box/')) {
        const boxId = url.pathname.substring('/api/box/'.length);
        
        if (req.method === 'GET') {
          if (!textBoxes[boxId]) {
            return new Response(JSON.stringify({ error: 'Textbox not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          return new Response(JSON.stringify({ text: textBoxes[boxId].text }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      return new Response('Not found', { status: 404 });
    }
    
    // Home route - create a new textbox and redirect
    if (url.pathname === '/') {
      const newBoxId = uuidv4();
      textBoxes[newBoxId] = { text: '', lastUpdated: Date.now() };
      
      return new Response(null, {
        status: 302,
        headers: { 'Location': `/box/${newBoxId}` }
      });
    }
    
    // Specific textbox route
    if (url.pathname.startsWith('/box/')) {
      const boxId = url.pathname.substring('/box/'.length);
      
      // If box doesn't exist, create it
      if (!textBoxes[boxId]) {
        textBoxes[boxId] = { text: '', lastUpdated: Date.now() };
      }
      
      // Serve the index.html
      try {
        const indexHtml = fs.readFileSync(path.join(publicPath, 'index.html'), 'utf8');
        return new Response(indexHtml, {
          headers: { 'Content-Type': 'text/html' }
        });
      } catch (error) {
        return new Response('Error loading page', { status: 500 });
      }
    }
    
    // Static files
    try {
      const filePath = path.join(publicPath, url.pathname === '/' ? 'index.html' : url.pathname);
      const file = Bun.file(filePath);
      const exists = fs.existsSync(filePath);
      
      if (exists) {
        return new Response(file);
      }
    } catch (error) {
      // Fall through to 404
    }
    
    return new Response('Not found', { status: 404 });
  },
});

console.log(`Server is running at http://localhost:${server.port}`);

// Implement a simple cleanup mechanism to prevent memory leaks
// In production, use a proper database instead
setInterval(() => {
  const now = Date.now();
  // Keep boxes for 30 days (in milliseconds)
  const expiryTime = 30 * 24 * 60 * 60 * 1000;
  
  Object.keys(textBoxes).forEach(id => {
    if (now - textBoxes[id].lastUpdated > expiryTime) {
      delete textBoxes[id];
    }
  });
}, 24 * 60 * 60 * 1000); // Run once a day
