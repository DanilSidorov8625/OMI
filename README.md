# 🌌 One Million Images

A collaborative digital canvas where **anyone can upload an image into a giant 1000x1000 grid**.  
Each tile holds one image forever—you can zoom, pan, explore, and watch new uploads arrive live.

---

## 📖 Story of the Build

I wanted to test myself with a project that was **fun, visually striking, and technically deep**.  
Something simple at the surface—*“upload an image to a grid”*—but complex under the hood.

The result was **One Million Images**:  
- A **giant interactive canvas** that can be explored like a map.  
- Built from scratch with **vanilla JS** on the frontend (no React, no frameworks) to sharpen my fundamentals.  
- A backend with **Node.js, Express, Socket.io, SQLite, Redis**, and **Cloudflare R2** storage.  
- A **custom logging system** for both client and server, because I wanted to understand what Sentry does before layering it in.

---

## 🎨 The Experience

- **Upload**: Double-click a tile to claim it, or let the system pick a random empty slot.
- **Explore**: Zoom, pan, drag, or pinch to move around the giant 1000x1000 board.
- **Mini-map**: See where you are at a glance, like navigating a game world.
- **Live feed**: New images appear instantly via **Socket.io**.
- **Zoom behavior**: At a distance you see thumbnails; zoom in close enough and the full-resolution image swaps in.

---
## 📸 Preview

![Preview](./Preview-OMI.avif)
---

## 🔑 What Makes It Interesting

- **Aggressive Caching**
  - Browser-side and server-side caching.
  - Dead-simple since images are immutable: once uploaded, never deleted. No invalidation headaches.

- **Custom Logging**
  - Client console logs and runtime errors are batched to the backend.
  - Rotated into **zipped log files** I can analyze later.
  - Added **Sentry integration** after the custom logger to compare both approaches.

- **Mobile Gestures**
  - Pinch-to-zoom, two-finger panning, double-tap highlight.
  - A smooth experience on touchscreen devices.

- **Performance-Oriented Design**
  - Only loads tiles that are visible (and a small halo around them).
  - If you zoom out too far, you’ll notice rows loading one-by-one—because I prioritized low memory usage over full scalability.
  - Image pipeline: uploads converted into **WebP thumbnails** + **original stored separately**. Thumbs render fast; originals swap in on closer zoom.

- **Cost-Optimized Hosting**
  - Runs on a **$5/month Linode** server.  
  - **Cloudflare R2** chosen for near-zero egress costs.  
  - Watchtower handles auto-updates for CI/CD.  

---

## 🧰 Tech Stack

- **Frontend**
  - Pure **vanilla JS** (canvas-based rendering, no frameworks).
  - CSS & DOM manipulations for sidebar, feed, minimap.

- **Backend**
  - Node.js + Express
  - Socket.io for realtime updates
  - Redis (optional, toggleable) for caching
  - SQLite (WAL mode, fast reads/writes)
  - Sharp for image resizing & WebP conversion

- **Infra & Ops**
  - Cloudflare R2 (S3-compatible storage)  
  - Docker + Docker Compose  
  - Watchtower (CI/CD auto-update)  
  - Jest for testing  
  - Sentry + custom logging system  

---

## 📊 Limitations

- **Scalability trade-off**:  
  Loads only what’s visible; if you zoom way out, images populate slowly. This keeps memory and bandwidth predictable.  

- **Single writer DB (SQLite)**:  
  Perfectly fine for hobby/demo scale. WAL mode makes reads/writes fast enough.  

- **Daily upload caps**:  
  Added per-IP limits to prevent spam and keep the grid usable.

---

## 🧩 Challenges I Faced

- **Server Costs vs. Traffic**  
  Hosting on a **$5 Linode** meant every decision had to respect CPU and bandwidth limits. Thumbnails in WebP format and R2 storage were critical—otherwise, egress costs alone would have sunk the project.  

- **Log Noise from Client Errors**  
  Browsers produce noisy errors (extensions, CORS, etc.), so I had to add **sampling, filtering, and batching** to keep logs meaningful and cheap to store.  

- **Race Conditions on Uploads**  
  Occasionally two users tried to grab the same tile at the same time. Solved with a **unique index** at the DB level (`x,y`) so only one wins cleanly.  

- **Mobile Performance**  
  Early versions of pinch-to-zoom stuttered. I rewrote it to compute zoom around the grid coordinate under the fingers—anchoring the gesture felt natural and smooth.  

- **Rate Limiting**  
  Without controls, someone could spam uploads and flood the grid. I layered **express-rate-limit** with custom per-IP checks in SQLite for robust throttling.

---

## 🔮 What I’d Do Differently (If Scaling Up)

If this project were to grow beyond hobby scale, here’s how I’d evolve it:

1. **Database**  
   - Migrate from **SQLite → PostgreSQL** for multi-writer support.  
   - Add background workers to process uploads and store metadata asynchronously.  

2. **Rendering**  
   - Implement **progressive tile loading** (like Google Maps) so zooming out doesn’t feel sluggish.  
   - Consider WebGL for rendering instead of 2D canvas for smoother large-scale performance.  

3. **Infra**  
   - Deploy to **Kubernetes** or managed Fargate for horizontal scaling.  
   - Use Cloudflare Workers to cache popular tile regions at the edge.  

4. **Storage**  
   - Pre-generate multiple thumbnail sizes (LOD levels) to avoid blurry tiles at intermediate zooms.  

5. **Logging & Monitoring**  
   - Expand the custom logger into a lightweight ELK-style pipeline.  
   - Keep Sentry, but also expose metrics in Prometheus/Grafana.  

6. **Community Features**  
   - User accounts with history of uploads.  
   - Leaderboards for most active contributors.  
   - Moderation tools for inappropriate uploads.  

---
