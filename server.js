/**
 * Path Editor - Node.js module
 * Main server entry point
 */

const express = require('express');
const path = require('path');
const pathRoutes = require('./routes/pathRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/path', pathRoutes);

// Serve the main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`\n  Path Editor running at http://localhost:${PORT}\n`);
});

// Export for use as a module in a larger app
module.exports = app;
