import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTH_SEPARATOR_BG_COLOR,
  CURRENT_MONTH_OPP_SEPARATOR_BG_COLOR,
  NOTIFICATION_HIGHLIGHT_BG_COLOR,
  NOTIFICATION_HIGHLIGHT_BORDER_COLOR,
  getSeparatorRowColor,
  normalizeCr,
  isCustomerMatchedByCr,
  checkCustomerCrDuplicate,
  getCustomerDateColorAndStatus,
  generateSalesOrderId,
  createActivityLogEntry,
  renderActivityLogsHTML,
  calculateCrmNotifications,
} from './crm_logic.js';

test('month separator colors match exact specification (#DDEBF7 and #9BC2E6)', () => {
  assert.equal(MONTH_SEPARATOR_BG_COLOR, '#DDEBF7');
  assert.equal(CURRENT_MONTH_OPP_SEPARATOR_BG_COLOR, '#9BC2E6');
  assert.equal(getSeparatorRowColor('visits', false), '#DDEBF7');
  assert.equal(getSeparatorRowColor('customers', false), '#DDEBF7');
  assert.equal(getSeparatorRowColor('sales', false), '#DDEBF7');
  assert.equal(getSeparatorRowColor('order_details', false), '#DDEBF7');
  assert.equal(getSeparatorRowColor('opportunities', false), '#DDEBF7');
  assert.equal(getSeparatorRowColor('opportunities', true), '#9BC2E6');
});

test('notification highlight colors are yellow (#FEF08A / #EAB308)', () => {
  assert.equal(NOTIFICATION_HIGHLIGHT_BG_COLOR, '#FEF08A');
  assert.equal(NOTIFICATION_HIGHLIGHT_BORDER_COLOR, '#EAB308');
});

test('calculateCrmNotifications generates notifications for visits, opportunities, customers, sales, and reminders', () => {
  const now = new Date(2026, 9, 31);
  const result = calculateCrmNotifications({
    customers: [{ code: 'CUST-00001', comp: 'شركة الأفق', date: '2026-08-01' }],
    opportunities: [{ id: 'opp_1', comp: 'شركة الرواد', status: 'مهتم', expDate: '2026-10-31', oppValue: 5000 }],
    visits: [{ id: 'visit_1', comp: 'شركة المدار', status: 'متابعة', visitDate: '31-10-2026' }],
    sales: [{ id: '26100022', comp: 'مؤسسة رؤية المستقبل', type: 'راوتر 5G', status: 'تفعيلات', date: '28-10-2026' }],
    reminders: [{ id: 'note_0', title: 'اجتماع', text: 'متابعة العقد', date: '2026-10-31' }],
    now,
  });

  assert.equal(result.notifications.length, 5);
  assert.ok(result.notifications.some((n) => n.category === 'sale' && n.url.includes('sales.html?highlight=26100022')));
  assert.ok(result.notifications.some((n) => n.category === 'opportunity' && n.url.includes('opportunities.html?highlight=opp_1')));
  assert.ok(result.notifications.some((n) => n.category === 'visit' && n.url.includes('visits.html?highlight=visit_1')));
  assert.ok(result.notifications.some((n) => n.category === 'customer' && n.url.includes('customers.html?highlight=CUST-00001')));
  assert.ok(result.notifications.some((n) => n.category === 'reminder' && n.url.includes('reminders.html?highlight=note_0')));
});

test('normalizeCr converts Arabic digits and strips non-digits', () => {
  assert.equal(normalizeCr('١٠١٠٣٤٥٦٧٨'), '1010345678');
  assert.equal(normalizeCr('CR-1010345678 '), '1010345678');
});

test('isCustomerMatchedByCr matches customer against object or string CR', () => {
  const customer = { code: 'CUST-00001', comp: 'شركة الأفق', cr: '1010345678' };
  assert.equal(isCustomerMatchedByCr(customer, '1010345678'), true);
  assert.equal(isCustomerMatchedByCr(customer, { record: '١٠١٠٣٤٥٦٧٨' }), true);
  assert.equal(isCustomerMatchedByCr(customer, { cr: '4030112233' }), false);
});

test('checkCustomerCrDuplicate detects duplicate CR and ignores currentCustomerCode', () => {
  const existing = [
    { code: 'CUST-00001', comp: 'شركة الأفق', cr: '1010345678' },
    { code: 'CUST-00002', comp: 'مستشفى الرعاية', cr: '4030112233' },
  ];

  const dup = checkCustomerCrDuplicate({
    cr: '1010345678',
    existingCustomers: existing,
  });
  assert.equal(dup.isDuplicate, true);
  assert.equal(dup.matchedCr, '1010345678');

  const selfEdit = checkCustomerCrDuplicate({
    cr: '1010345678',
    existingCustomers: existing,
    currentCustomerCode: 'CUST-00001',
  });
  assert.equal(selfEdit.isDuplicate, false);
});

test('getCustomerDateColorAndStatus returns green (<=30d), yellow (31-60d), red (>60d)', () => {
  const now = new Date(2026, 9, 31); // Oct 31, 2026
  const tenDaysAgo = new Date(2026, 9, 21).getTime();
  const fortyFiveDaysAgo = new Date(2026, 8, 16).getTime();
  const seventyDaysAgo = new Date(2026, 7, 22).getTime();

  const greenStatus = getCustomerDateColorAndStatus(tenDaysAgo, now);
  assert.equal(greenStatus.color, '#00B050');
  assert.equal(greenStatus.isInactiveDueToTime, false);

  const yellowStatus = getCustomerDateColorAndStatus(fortyFiveDaysAgo, now);
  assert.equal(yellowStatus.color, '#FFC000');
  assert.equal(yellowStatus.isInactiveDueToTime, false);

  const redStatus = getCustomerDateColorAndStatus(seventyDaysAgo, now);
  assert.equal(redStatus.color, '#C00000');
  assert.equal(redStatus.isInactiveDueToTime, true);
});

test('generateSalesOrderId increments sequence for current YYMM', () => {
  const now = new Date(2026, 9, 31); // 2610
  const id1 = generateSalesOrderId([], now);
  assert.equal(id1, '26100001');

  const id2 = generateSalesOrderId([{ id: '26100004' }], now);
  assert.equal(id2, '26100005');
});

test('createActivityLogEntry skips unchanged values and renders HTML cleanly', () => {
  const unchanged = createActivityLogEntry({
    page: 'visits',
    fieldName: 'الشركة',
    oldVal: 'الأفق',
    newVal: 'الأفق',
    identifierValue: 'الأفق',
    user: 'أحمد',
  });
  assert.equal(unchanged, null);

  const changed = createActivityLogEntry({
    page: 'visits',
    fieldName: 'الحالة',
    oldVal: 'زيارة',
    newVal: 'مميزة',
    identifierValue: 'شركة الأفق',
    user: 'أحمد',
  });
  assert.ok(changed);
  const html = renderActivityLogsHTML([changed], 'visits');
  assert.ok(html.includes('شركة الأفق'));
  assert.ok(html.includes('مميزة'));
});
