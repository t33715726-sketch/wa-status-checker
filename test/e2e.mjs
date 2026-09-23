/**
 * בדיקת קצה-לקצה: מוודאת שהשרת פותח סשן ומחזיר קוד QR או קוד זיווג.
 * דורשת שרת רץ (npm start) ורשת פתוחה לוואטסאפ.
 *   node test/e2e.mjs [http://localhost:8080]
 */
import { io } from 'socket.io-client';

const url = process.argv[2] || 'http://localhost:8080';
const s = io(url, { transports: ['websocket'] });

s.on('connect', () => { console.log('מחובר לשרת'); s.emit('start', {}); });
s.on('session', (d) => console.log('סשן נוצר:', typeof d.sessionId === 'string'));
s.on('state', (d) => {
  console.log('מצב:', d.state, d.qr ? `(QR באורך ${d.qr.length})` : d.code ? `(קוד ${d.code})` : '');
  if (d.state === 'qr' || d.state === 'pairing') { s.emit('end'); s.close(); process.exit(0); }
});
s.on('failed', (d) => { console.error('נכשל:', d.code, d.message); process.exit(1); });
setTimeout(() => { console.error('פסק זמן'); process.exit(2); }, 60000);
