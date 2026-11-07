// Shows the app's push notifications, and opens the right parlay when one is
// tapped. (A service worker: the browser runs it even when the app is closed.)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The red number on the app icon: how many notifications are waiting in
// Notification Center (a newer note about the same bet replaces the older one,
// so it isn't counted twice). iPhone: iOS 16.4+, with notifications allowed.
async function updateBadge() {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    const waiting = (await self.registration.getNotifications()).length;
    if (waiting > 0) await self.navigator.setAppBadge(waiting);
    else await self.navigator.clearAppBadge();
  } catch {
    // No count available: leave the badge as it is.
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Parlays', body: event.data?.text() ?? '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Parlays', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag, // a newer note about the same bet replaces the older one
    data: { url: data.url || '/' },
  }).then(updateBadge));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(updateBadge());
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      await win.navigate(url);
      return win.focus();
    }
    return self.clients.openWindow(url);
  })());
});
