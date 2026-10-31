// =========================================================================
// src/crm_logic.js - المنطق البرمجي الموحد لنظام ASGate CRM (متوافق مع المتصفح و GitHub Pages و Vite)
// =========================================================================

export const MONTH_SEPARATOR_BG_COLOR = '#DDEBF7';
export const CURRENT_MONTH_OPP_SEPARATOR_BG_COLOR = '#9BC2E6';
export const NOTIFICATION_HIGHLIGHT_BG_COLOR = '#FEF08A';
export const NOTIFICATION_HIGHLIGHT_BORDER_COLOR = '#EAB308';

export function getSeparatorRowColor(page, isCurrentMonth = false) {
  if (page === 'opportunities' && isCurrentMonth) {
    return CURRENT_MONTH_OPP_SEPARATOR_BG_COLOR;
  }
  return MONTH_SEPARATOR_BG_COLOR;
}

export function toEnglishDigits(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 48))
    .replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 48));
}

export function normalizeCr(val) {
  if (val === null || val === undefined) return '';
  return toEnglishDigits(val).replace(/\D/g, '').trim();
}

export function extractCrList(entity) {
  if (!entity) return [];
  if (typeof entity === 'string' || typeof entity === 'number') {
    const clean = normalizeCr(entity);
    return clean ? [clean] : [];
  }
  if (typeof entity === 'object') {
    const rawValues = [
      entity.cr,
      entity.cr1,
      entity.cr2,
      entity.record,
      entity.commercialRecord,
    ];
    const set = new Set();
    for (const raw of rawValues) {
      const clean = normalizeCr(raw);
      if (clean && clean.length >= 5) {
        set.add(clean);
      }
    }
    return Array.from(set);
  }
  return [];
}

export function isCustomerMatchedByCr(customer, target) {
  const custCrs = extractCrList(customer);
  const targetCrs = extractCrList(target);
  if (custCrs.length === 0 || targetCrs.length === 0) return false;
  return custCrs.some((cr) => targetCrs.includes(cr));
}

export function checkCustomerCrDuplicate(params = {}) {
  const candidateCrs = [
    normalizeCr(params.cr),
    normalizeCr(params.cr1),
    normalizeCr(params.cr2),
  ].filter((c) => c.length >= 5);

  if (candidateCrs.length === 0) {
    return { isDuplicate: false };
  }

  const list = Array.isArray(params.existingCustomers) ? params.existingCustomers : [];
  const currentCode = params.currentCustomerCode ? String(params.currentCustomerCode).trim() : '';

  for (const cust of list) {
    if (!cust) continue;
    const custCode = String(cust.code || '').trim();
    if (currentCode && custCode === currentCode) continue;

    const custCrs = extractCrList(cust);
    for (const candidate of candidateCrs) {
      if (custCrs.includes(candidate)) {
        const compName = cust.comp || cust.name || custCode || 'عميل آخر';
        return {
          isDuplicate: true,
          matchedCr: candidate,
          matchedCustomer: cust,
          message: `رقم السجل التجاري (${candidate}) مسجل مسبقاً باسم: ${compName}`,
        };
      }
    }
  }

  return { isDuplicate: false };
}

export function parseDateToTimestamp(dateInput) {
  if (!dateInput && dateInput !== 0) return 0;

  if (typeof dateInput === 'number') {
    if (dateInput > 1e11) return dateInput;
    if (dateInput > 1e9) return dateInput * 1000;
    if (dateInput > 20000 && dateInput < 80000) {
      return Math.floor((dateInput - 25569) * 86400 * 1000);
    }
    return 0;
  }

  if (dateInput instanceof Date) {
    const t = dateInput.getTime();
    return isNaN(t) ? 0 : t;
  }

  if (typeof dateInput === 'object' && typeof dateInput.seconds === 'number') {
    return dateInput.seconds * 1000;
  }

  const raw = toEnglishDigits(String(dateInput)).trim();
  if (!raw || raw === '-' || raw === '---') return 0;

  const datePart = raw.split(' ')[0].split('T')[0].replace(/\//g, '-');
  const parts = datePart.split('-');
  if (parts.length === 3) {
    const p0 = parseInt(parts[0], 10);
    const p1 = parseInt(parts[1], 10);
    const p2 = parseInt(parts[2], 10);
    if (!isNaN(p0) && !isNaN(p1) && !isNaN(p2)) {
      if (parts[0].length === 4) {
        const d = new Date(p0, p1 - 1, p2);
        return isNaN(d.getTime()) ? 0 : d.getTime();
      } else if (parts[2].length === 4) {
        const d = new Date(p2, p1 - 1, p0);
        return isNaN(d.getTime()) ? 0 : d.getTime();
      }
    }
  }

  const parsed = new Date(raw).getTime();
  return isNaN(parsed) ? 0 : parsed;
}

export function getCustomerDateColorAndStatus(latestTimestamp, now = new Date()) {
  if (!latestTimestamp || latestTimestamp <= 0) {
    return {
      latestTimestamp: 0,
      daysSince: 999,
      color: '#C00000',
      badgeClass: 'date-color-red',
      isInactiveDueToTime: true,
    };
  }

  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const targetDate = new Date(latestTimestamp);
  const targetMidnight = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate()
  ).getTime();

  const diffDays = Math.max(0, Math.floor((nowMidnight - targetMidnight) / (1000 * 60 * 60 * 24)));

  if (diffDays > 60) {
    return {
      latestTimestamp,
      daysSince: diffDays,
      color: '#C00000',
      badgeClass: 'date-color-red',
      isInactiveDueToTime: true,
    };
  }

  if (diffDays > 30) {
    return {
      latestTimestamp,
      daysSince: diffDays,
      color: '#FFC000',
      badgeClass: 'date-color-yellow',
      isInactiveDueToTime: false,
    };
  }

  return {
    latestTimestamp,
    daysSince: diffDays,
    color: '#00B050',
    badgeClass: 'date-color-green',
    isInactiveDueToTime: false,
  };
}

export function generateSalesOrderId(existingSales = [], now = new Date()) {
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${year}${month}`;

  let maxSeq = 0;
  const list = Array.isArray(existingSales) ? existingSales : [];
  for (const item of list) {
    const idStr = String((item && item.id) || item || '').trim();
    if (idStr.startsWith(prefix) && idStr.length >= 8) {
      const seq = parseInt(idStr.slice(4), 10);
      if (!isNaN(seq) && seq > maxSeq) {
        maxSeq = seq;
      }
    }
  }

  return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`;
}

function escapeHtmlSafe(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function createActivityLogEntry(params = {}) {
  const fieldName = String(params.fieldName || 'تحديث').trim();
  const oldVal = String(params.oldVal ?? '').trim();
  const newVal = String(params.newVal ?? '').trim();

  const isAction =
    fieldName === 'إجراء' ||
    fieldName === 'زر إجراء' ||
    fieldName === 'إضافة منتج جديد' ||
    fieldName === 'سجل المتابعة' ||
    fieldName === 'الملاحظات' ||
    fieldName === 'لصق من إكسيل' ||
    fieldName === 'نسخ Excel';

  if (!isAction && oldVal === newVal) {
    return null;
  }

  const d = params.now || new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const dateStr = `${day}-${month}-${year}`;
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  const identifier = String(params.identifier || params.identifierValue || '').trim();
  const user = String(params.user || 'المستخدم').trim() || 'المستخدم';

  return {
    id: `log_${d.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: d.getTime(),
    date: dateStr,
    time: timeStr,
    user,
    page: params.page || 'general',
    fieldName,
    oldVal,
    newVal,
    identifier,
  };
}

export function renderActivityLogsHTML(logs, _page) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return `<div style="color:#94a3b8; font-size:10px; text-align:center; padding:8px; font-weight:700;">لا توجد أنشطة مسجلة بعد</div>`;
  }

  return logs
    .map((log) => {
      if (!log || typeof log !== 'object') return '';
      if (log.html) return log.html;

      const user = escapeHtmlSafe(log.user || 'المستخدم');
      const date = escapeHtmlSafe(toEnglishDigits(log.date || ''));
      const time = escapeHtmlSafe(toEnglishDigits(log.time || ''));
      const fieldName = escapeHtmlSafe(log.fieldName || 'تحديث');
      const oldVal = escapeHtmlSafe(log.oldVal || '');
      const newVal = escapeHtmlSafe(log.newVal || '');
      const identifier = escapeHtmlSafe(log.identifier || log.identifierValue || '');

      let actionDesc = '';
      if (fieldName === 'إجراء' || fieldName === 'زر إجراء') {
        actionDesc = `${oldVal || newVal}`;
      } else if (oldVal && newVal) {
        actionDesc = `تعديل <b>${fieldName}</b> من (${oldVal}) إلى (<b>${newVal}</b>)`;
      } else if (newVal) {
        actionDesc = `تحديث <b>${fieldName}</b>: <b>${newVal}</b>`;
      } else if (oldVal) {
        actionDesc = `مسح <b>${fieldName}</b> (كان: ${oldVal})`;
      } else {
        actionDesc = `${fieldName}`;
      }

      const idBadge = identifier
        ? `<span class="company-highlight">${identifier}</span>`
        : '';

      return `<div class="log-entry">
        <span class="log-header-info">
          <span class="user-highlight"><i class="fas fa-user"></i> ${user}</span>
          <span><i class="far fa-calendar-alt"></i> ${date}</span>
          <span><i class="far fa-clock"></i> ${time}</span>
        </span>
        <span class="log-sep">|</span>
        <span class="log-action">${idBadge} ${actionDesc}</span>
      </div>`;
    })
    .join('');
}

export function calculateCrmNotifications(params = {}) {
  const now = params.now || new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const readSet = new Set(Array.isArray(params.readNotificationIds) ? params.readNotificationIds : []);
  const items = [];

  // 1. التذكيرات (Reminders)
  const reminders = Array.isArray(params.reminders) ? params.reminders : [];
  reminders.forEach((rem, idx) => {
    if (!rem || (!rem.title && !rem.text) || !rem.date) return;
    const ts = parseDateToTimestamp(rem.date);
    if (!ts) return;
    const remDate = new Date(ts);
    const remMidnight = new Date(remDate.getFullYear(), remDate.getMonth(), remDate.getDate()).getTime();
    const diffDays = Math.round((remMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
    const remId = rem.id || `note_${idx}`;
    const notifId = `notif_rem_${remId}_${rem.date}`;

    if (diffDays <= 3) {
      const isToday = diffDays === 0;
      const isOverdue = diffDays < 0;
      items.push({
        id: notifId,
        category: 'reminder',
        title: rem.title || 'تذكير هام',
        message: rem.text || 'موعد تذكير مجدول في المفكرة',
        date: rem.date,
        url: `reminders.html?highlight=${encodeURIComponent(remId)}`,
        badgeText: isToday ? 'تذكير اليوم' : isOverdue ? 'تذكير متأخر' : `خلال ${diffDays} أيام`,
        badgeClass: isOverdue ? 'badge-danger' : isToday ? 'badge-success' : 'badge-warning',
        actionText: 'فتح التذكير',
        isToday,
        isRead: readSet.has(notifId),
        priority: isToday ? 1 : isOverdue ? 2 : 3,
      });
    }
  });

  // 2. الفرص البيعية (Opportunities)
  const opportunities = Array.isArray(params.opportunities) ? params.opportunities : [];
  opportunities.forEach((opp) => {
    if (!opp || opp.status !== 'مهتم') return;
    const oppId = opp.id || '';
    const compName = opp.comp || 'فرصة بيعية';
    if (!opp.expDate) {
      const notifId = `notif_opp_nodate_${oppId}`;
      items.push({
        id: notifId,
        category: 'opportunity',
        title: `فرصة بدون تاريخ متوقع: ${compName}`,
        message: `الخدمة: ${opp.curServ || '-'} | القيمة: ${opp.oppValue || 0} ر.س`,
        date: opp.oppDate || '-',
        url: `opportunities.html?highlight=${encodeURIComponent(oppId)}`,
        badgeText: 'تحديد موعد',
        badgeClass: 'badge-warning',
        actionText: 'عرض الفرصة',
        isToday: false,
        isRead: readSet.has(notifId),
        priority: 4,
      });
      return;
    }

    const ts = parseDateToTimestamp(opp.expDate);
    if (!ts) return;
    const expDate = new Date(ts);
    const expMidnight = new Date(expDate.getFullYear(), expDate.getMonth(), expDate.getDate()).getTime();
    const diffDays = Math.round((expMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
    if (diffDays <= 5) {
      const isToday = diffDays === 0;
      const isOverdue = diffDays < 0;
      const notifId = `notif_opp_${oppId}_${opp.expDate}`;
      items.push({
        id: notifId,
        category: 'opportunity',
        title: `متابعة فرصة: ${compName}`,
        message: `${opp.curServ || 'فرصة بيعية'} (${Number(opp.oppValue || 0).toLocaleString('en-US')} ر.س)`,
        date: opp.expDate,
        url: `opportunities.html?highlight=${encodeURIComponent(oppId)}`,
        badgeText: isToday ? 'إغلاق اليوم' : isOverdue ? 'تجاوز الموعد' : `متبقي ${diffDays} يوم`,
        badgeClass: isOverdue ? 'badge-danger' : isToday ? 'badge-success' : 'badge-warning',
        actionText: 'عرض الفرصة',
        isToday,
        isRead: readSet.has(notifId),
        priority: isToday ? 1 : isOverdue ? 2 : 3,
      });
    }
  });

  // 3. العملاء (Customers)
  const customers = Array.isArray(params.customers) ? params.customers : [];
  customers.forEach((cust) => {
    if (!cust) return;
    const ts = parseDateToTimestamp(
      cust.lastActivityDate || cust.updatedAt || cust.creationDate || cust.date
    );
    const statusInfo = getCustomerDateColorAndStatus(ts, now);
    if (statusInfo.daysSince > 30) {
      const code = cust.code || '';
      const notifId = `notif_cust_${code}`;
      items.push({
        id: notifId,
        category: 'customer',
        title: `عميل بحاجة لمتابعة: ${cust.comp || cust.name || code}`,
        message: `لم يتم تسجيل نشاط منذ ${statusInfo.daysSince > 500 ? 'فترة طويلة' : statusInfo.daysSince + ' يوم'}`,
        date: cust.creationDate || cust.date || '-',
        url: `customers.html?highlight=${encodeURIComponent(code)}`,
        badgeText: statusInfo.isInactiveDueToTime ? 'غير نشط (+60 يوم)' : 'تنبيه (+30 يوم)',
        badgeClass: statusInfo.isInactiveDueToTime ? 'badge-danger' : 'badge-warning',
        actionText: 'عرض العميل',
        isToday: false,
        isRead: readSet.has(notifId),
        priority: statusInfo.isInactiveDueToTime ? 3 : 5,
      });
    }
  });

  // 4. الزيارات (Visits)
  const visits = Array.isArray(params.visits) ? params.visits : [];
  visits.forEach((visit) => {
    if (!visit || visit.status === 'غير مهتم' || visit.status === 'فقدان') return;
    const ts = parseDateToTimestamp(visit.editDate || visit.visitDate);
    if (!ts) return;
    const vDate = new Date(ts);
    const vMidnight = new Date(vDate.getFullYear(), vDate.getMonth(), vDate.getDate()).getTime();
    const diffDays = Math.floor((todayMidnight - vMidnight) / (1000 * 60 * 60 * 24));
    const isToday = diffDays === 0;

    if (isToday || diffDays > 10) {
      const vId = visit.id || '';
      const notifId = `notif_visit_${vId}`;
      items.push({
        id: notifId,
        category: 'visit',
        title: `زيارة ميدانية: ${visit.comp || 'عميل'}`,
        message: isToday
          ? `زيارة مسجلة اليوم (${visit.curServ || 'متابعة'})`
          : `مضى ${diffDays} يوم دون تحديث حالة الزيارة (${visit.status || 'متابعة'})`,
        date: visit.visitDate || '-',
        url: `visits.html?highlight=${encodeURIComponent(vId)}`,
        badgeText: isToday ? 'زيارة اليوم' : diffDays > 30 ? 'متأخرة (+30 يوم)' : 'متابعة (+10 أيام)',
        badgeClass: isToday ? 'badge-success' : diffDays > 30 ? 'badge-danger' : 'badge-warning',
        actionText: 'عرض الزيارة',
        isToday,
        isRead: readSet.has(notifId),
        priority: isToday ? 1 : diffDays > 30 ? 3 : 5,
      });
    }
  });

  // 5. المبيعات (Sales)
  const sales = Array.isArray(params.sales) ? params.sales : [];
  sales.forEach((sale) => {
    if (!sale || !sale.id || sale.status === 'مكتمل' || sale.status === 'فقدان') return;
    const ts = parseDateToTimestamp(sale.lastModifiedDate || sale.date);
    const sDate = ts ? new Date(ts) : now;
    const sMidnight = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate()).getTime();
    const diffDays = Math.max(0, Math.floor((todayMidnight - sMidnight) / (1000 * 60 * 60 * 24)));
    const isToday = diffDays === 0;

    const notifId = `notif_sale_${sale.id}_${sale.status || 'pending'}`;
    items.push({
      id: notifId,
      category: 'sale',
      title: `متابعة طلب مبيعات #${sale.id}: ${sale.comp || 'عميل'}`,
      message: `${sale.type || 'طلب مبيعات'} | الحالة: ${sale.status || 'قيد الإجراء'}`,
      date: sale.lastModifiedDate || sale.date || '-',
      url: `sales.html?highlight=${encodeURIComponent(sale.id)}`,
      badgeText: isToday ? 'طلب اليوم' : diffDays > 7 ? `معلق (${diffDays} يوم)` : (sale.status || 'قيد المتابعة'),
      badgeClass: isToday ? 'badge-info' : diffDays > 7 ? 'badge-danger' : 'badge-warning',
      actionText: 'عرض الطلب',
      isToday,
      isRead: readSet.has(notifId),
      priority: isToday ? 2 : diffDays > 7 ? 3 : 4,
    });
  });

  items.sort((a, b) => a.priority - b.priority);

  const unreadCount = items.filter((i) => !i.isRead).length;
  const todayCount = items.filter((i) => i.isToday).length;

  return {
    notifications: items,
    unreadCount,
    todayCount,
  };
}
