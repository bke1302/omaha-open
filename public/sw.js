/* Service Worker מינימלי — נדרש להתקנת האפליקציה על מסך הבית.
   בכוונה לא שומר כלום במטמון: משחק אונליין חייב מידע חי מהשרת. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* מעבר ישיר לרשת */ });
