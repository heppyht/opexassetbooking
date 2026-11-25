/*───────────────────── Mandatory Actor Validation Regression ─────────────────────*/
/* Verifies that notification mutations (markAsRead / markAllAsRead /
   markDeliveryStatus) require a verified actor and enforce recipient
   ownership. The actor is now a REQUIRED parameter and the providers fail
   closed when it is missing/blank or does not match the notification owner.

   Uses the in-memory DEMO provider (LocalBookingDataProvider) so the
   ownership logic is exercised without any MyGeotab/AddInData mocking. */

import test from "node:test";
import assert from "node:assert/strict";
import { LocalBookingDataProvider } from "../src/data/dataProvider.ts";

async function freshDemoProvider() {
  const p = new LocalBookingDataProvider();
  await p.resetDemoData();
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("opex-vbm-demo-bookings");
    localStorage.removeItem("opex-vbm-demo-notifications");
    localStorage.removeItem("opex-vbm-demo-audit");
  }
  return p;
}

let seq = 0;
async function seedNotification(p, recipientUserId) {
  const n = await p.createNotification({
    eventId: `evt-${++seq}`,
    idempotencyKey: `idem-${++seq}`,
    type: "booking_created",
    recipient_user_id: recipientUserId,
    related_booking_id: "b1",
    title: "T",
    message: "M",
  });
  return n;
}

/*───────────────────── markAsRead ─────────────────────*/

test("actor: markAsRead with owning actor marks the notification read", async () => {
  const p = await freshDemoProvider();
  const n = await seedNotification(p, "userA");
  await p.markAsRead(n.id, "userA");
  const list = await p.getNotifications("userA");
  assert.equal(list[0].is_read, true);
});

test("actor: markAsRead with a different actor is rejected (fail closed)", async () => {
  const p = await freshDemoProvider();
  const n = await seedNotification(p, "userA");
  await p.markAsRead(n.id, "userB");
  const list = await p.getNotifications("userA");
  assert.equal(list[0].is_read, false);
});

test("actor: markAsRead with a blank actor is rejected (fail closed)", async () => {
  const p = await freshDemoProvider();
  const n = await seedNotification(p, "userA");
  await p.markAsRead(n.id, "   ");
  const list = await p.getNotifications("userA");
  assert.equal(list[0].is_read, false);
});

/*───────────────────── markAllAsRead ─────────────────────*/

test("actor: markAllAsRead with owning actor marks all read", async () => {
  const p = await freshDemoProvider();
  await seedNotification(p, "userA");
  await seedNotification(p, "userA");
  await p.markAllAsRead("userA", "userA");
  assert.equal(await p.getUnreadCount("userA"), 0);
});

test("actor: markAllAsRead for another user's id is rejected (fail closed)", async () => {
  const p = await freshDemoProvider();
  await seedNotification(p, "userA");
  await p.markAllAsRead("userA", "userB");
  assert.equal(await p.getUnreadCount("userA"), 1);
});

test("actor: markAllAsRead with a blank actor is rejected (fail closed)", async () => {
  const p = await freshDemoProvider();
  await seedNotification(p, "userA");
  await p.markAllAsRead("userA", "");
  assert.equal(await p.getUnreadCount("userA"), 1);
});

/*───────────────────── markDeliveryStatus ─────────────────────*/

test("actor: markDeliveryStatus with owning actor updates status", async () => {
  const p = await freshDemoProvider();
  const n = await seedNotification(p, "userA");
  await p.markDeliveryStatus(n.id, "delivered", "userA");
  const list = await p.getNotifications("userA");
  assert.equal(list[0].delivery_status, "delivered");
  assert.ok(list[0].delivered_at);
});

test("actor: markDeliveryStatus with a different actor is rejected (fail closed)", async () => {
  const p = await freshDemoProvider();
  const n = await seedNotification(p, "userA");
  await p.markDeliveryStatus(n.id, "delivered", "userB");
  const list = await p.getNotifications("userA");
  assert.equal(list[0].delivery_status, "pending");
});

test("actor: markDeliveryStatus with a blank actor is rejected (fail closed)", async () => {
  const p = await freshDemoProvider();
  const n = await seedNotification(p, "userA");
  await p.markDeliveryStatus(n.id, "failed", "");
  const list = await p.getNotifications("userA");
  assert.equal(list[0].delivery_status, "pending");
});