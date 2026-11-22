"use strict";

self.addEventListener("push", (event) => {
  const alert = event.data?.json();
  if (!Number.isSafeInteger(alert?.id)) return;
  event.waitUntil(self.registration.showNotification(alert.title, {
    body: alert.body, icon: "/favicon.svg", tag: "market-alert-" + alert.id, data: alert.id
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data;
  if (!Number.isSafeInteger(id)) return;
  const url = new URL("/markets#watchlist/alerts/" + id, self.location.origin);
  event.waitUntil(self.clients.openWindow(url));
});
