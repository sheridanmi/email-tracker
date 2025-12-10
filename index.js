/**
 * Email Tracking Server
 * Handles open tracking (pixel), link click tracking, and provides API for stats
 * 
 * Free deployment options: Render.com, Railway.app, Vercel, Fly.io
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'tracking.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    subject TEXT,
    recipient TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_email TEXT
  );

  CREATE TABLE IF NOT EXISTS opens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT,
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    FOREIGN KEY (email_id) REFERENCES emails(id)
  );

  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    email_id TEXT,
    original_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (email_id) REFERENCES emails(id)
  );

  CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id TEXT,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    FOREIGN KEY (link_id) REFERENCES links(id)
  );

  CREATE INDEX IF NOT EXISTS idx_opens_email ON opens(email_id);
  CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id);
  CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_email);
`);

// Middleware
app.use(cors());
app.use(express.json());

// 1x1 transparent PNG pixel
const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ============================================
// TRACKING ENDPOINTS
// ============================================

/**
 * Tracking Pixel Endpoint
 * Embed this in emails: <img src="https://yourserver.com/t/EMAIL_ID.png" />
 */
app.get('/t/:emailId.png', (req, res) => {
  const { emailId } = req.params;
  
  // Log the open
  try {
    const stmt = db.prepare(`
      INSERT INTO opens (email_id, ip_address, user_agent)
      VALUES (?, ?, ?)
    `);
    stmt.run(
      emailId,
      req.headers['x-forwarded-for'] || req.ip,
      req.headers['user-agent'] || 'Unknown'
    );
  } catch (err) {
    console.error('Error logging open:', err);
  }

  // Return the tracking pixel
  res.set({
    'Content-Type': 'image/png',
    'Content-Length': TRACKING_PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(TRACKING_PIXEL);
});

/**
 * Link Click Tracking Endpoint
 * Redirect links through: https://yourserver.com/c/LINK_ID
 */
app.get('/c/:linkId', (req, res) => {
  const { linkId } = req.params;

  try {
    // Get the original URL
    const link = db.prepare('SELECT original_url FROM links WHERE id = ?').get(linkId);
    
    if (!link) {
      return res.status(404).send('Link not found');
    }

    // Log the click
    const stmt = db.prepare(`
      INSERT INTO clicks (link_id, ip_address, user_agent)
      VALUES (?, ?, ?)
    `);
    stmt.run(
      linkId,
      req.headers['x-forwarded-for'] || req.ip,
      req.headers['user-agent'] || 'Unknown'
    );

    // Redirect to original URL
    res.redirect(302, link.original_url);
  } catch (err) {
    console.error('Error processing click:', err);
    res.status(500).send('Error processing request');
  }
});

// ============================================
// API ENDPOINTS (for Gmail Add-on & Dashboard)
// ============================================

/**
 * Register a new tracked email
 */
app.post('/api/emails', (req, res) => {
  const { subject, recipient, userEmail } = req.body;
  const emailId = crypto.randomBytes(8).toString('hex');

  try {
    const stmt = db.prepare(`
      INSERT INTO emails (id, subject, recipient, user_email)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(emailId, subject, recipient, userEmail);

    res.json({
      emailId,
      trackingPixel: `${getBaseUrl(req)}/t/${emailId}.png`
    });
  } catch (err) {
    console.error('Error creating email:', err);
    res.status(500).json({ error: 'Failed to create email' });
  }
});

/**
 * Register a tracked link for an email
 */
app.post('/api/links', (req, res) => {
  const { emailId, originalUrl } = req.body;
  const linkId = crypto.randomBytes(6).toString('hex');

  try {
    const stmt = db.prepare(`
      INSERT INTO links (id, email_id, original_url)
      VALUES (?, ?, ?)
    `);
    stmt.run(linkId, emailId, originalUrl);

    res.json({
      linkId,
      trackedUrl: `${getBaseUrl(req)}/c/${linkId}`
    });
  } catch (err) {
    console.error('Error creating link:', err);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

/**
 * Get all emails for a user with stats
 */
app.get('/api/emails', (req, res) => {
  const { userEmail } = req.query;

  try {
    const emails = db.prepare(`
      SELECT 
        e.id,
        e.subject,
        e.recipient,
        e.sent_at,
        (SELECT COUNT(*) FROM opens WHERE email_id = e.id) as open_count,
        (SELECT MAX(opened_at) FROM opens WHERE email_id = e.id) as last_opened,
        (
          SELECT COUNT(*) FROM clicks c 
          JOIN links l ON c.link_id = l.id 
          WHERE l.email_id = e.id
        ) as click_count
      FROM emails e
      WHERE e.user_email = ?
      ORDER BY e.sent_at DESC
      LIMIT 100
    `).all(userEmail);

    res.json(emails);
  } catch (err) {
    console.error('Error fetching emails:', err);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

/**
 * Get detailed stats for a single email
 */
app.get('/api/emails/:emailId', (req, res) => {
  const { emailId } = req.params;

  try {
    const email = db.prepare(`
      SELECT * FROM emails WHERE id = ?
    `).get(emailId);

    if (!email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const opens = db.prepare(`
      SELECT opened_at, ip_address, user_agent 
      FROM opens 
      WHERE email_id = ? 
      ORDER BY opened_at DESC
    `).all(emailId);

    const links = db.prepare(`
      SELECT 
        l.id,
        l.original_url,
        (SELECT COUNT(*) FROM clicks WHERE link_id = l.id) as click_count
      FROM links l
      WHERE l.email_id = ?
    `).all(emailId);

    const clicks = db.prepare(`
      SELECT c.clicked_at, c.ip_address, c.user_agent, l.original_url
      FROM clicks c
      JOIN links l ON c.link_id = l.id
      WHERE l.email_id = ?
      ORDER BY c.clicked_at DESC
    `).all(emailId);

    res.json({
      ...email,
      opens,
      links,
      clicks,
      stats: {
        totalOpens: opens.length,
        uniqueOpens: new Set(opens.map(o => o.ip_address)).size,
        totalClicks: clicks.length,
        uniqueClicks: new Set(clicks.map(c => c.ip_address)).size
      }
    });
  } catch (err) {
    console.error('Error fetching email details:', err);
    res.status(500).json({ error: 'Failed to fetch email details' });
  }
});

/**
 * Get aggregate stats for dashboard
 */
app.get('/api/stats', (req, res) => {
  const { userEmail } = req.query;

  try {
    const stats = db.prepare(`
      SELECT 
        COUNT(DISTINCT e.id) as total_emails,
        (SELECT COUNT(*) FROM opens o JOIN emails e2 ON o.email_id = e2.id WHERE e2.user_email = ?) as total_opens,
        (
          SELECT COUNT(*) FROM clicks c 
          JOIN links l ON c.link_id = l.id 
          JOIN emails e3 ON l.email_id = e3.id 
          WHERE e3.user_email = ?
        ) as total_clicks
      FROM emails e
      WHERE e.user_email = ?
    `).get(userEmail, userEmail, userEmail);

    // Get opens by day for the last 7 days
    const opensByDay = db.prepare(`
      SELECT 
        DATE(o.opened_at) as date,
        COUNT(*) as count
      FROM opens o
      JOIN emails e ON o.email_id = e.id
      WHERE e.user_email = ?
        AND o.opened_at >= DATE('now', '-7 days')
      GROUP BY DATE(o.opened_at)
      ORDER BY date
    `).all(userEmail);

    res.json({
      ...stats,
      opensByDay
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Helper to get base URL
function getBaseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
app.listen(PORT, () => {
  console.log(`📧 Email Tracking Server running on port ${PORT}`);
});

module.exports = app;
