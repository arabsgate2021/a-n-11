// =========================================================================
// sales.js - إدارة المبيعات سحابياً ومحلياً (نظام ASGate CRM)
// تحسينات استهلاك كوتا فايربيز:
// 1. تحميل فوري من الكاش المحلي (asgate_sales_db) بدون انتظار الشبكة (0 Read Delay)
// 2. إلغاء استدعاء getDocs المزدوج مع onSnapshot لتوفير 50% من قراءات السحابة
// 3. تأخير (Debounce) إرسال التعديلات لفايربيز مع حفظ فوري بالكاش لمنع فقدان البيانات
// 4. استخدام writeBatch في الحذف والاستيراد الجماعي
// 5. ربط الطلب بالعميل برقم السجل التجاري وليس الاسم فقط
// =========================================================================

import Swal from 'sweetalert2';
import * as XLSX from 'xlsx';
window.Swal = Swal;
window.XLSX = XLSX;

import { db, collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch, query, where, getDocs } from './firebase-config.js';
import { isCustomerMatchedByCr, createActivityLogEntry, renderActivityLogsHTML } from './src/crm_logic.js';

const LOGS_KEY = 'asgate_sales_logs_v1';
const CUSTOMERS_STORAGE_KEY = 'crm_customers';
const HIGHEST_SEQ_STORAGE_KEY = 'asgate_sales_max_order_seq_v2';
const ALL_TIME_ORDER_IDS_KEY = 'asgate_sales_all_time_used_ids';
const saveTimeouts = {}; 

function getPersistentMaxSeq(prefix) {
    try {
        const stored = JSON.parse(localStorage.getItem(HIGHEST_SEQ_STORAGE_KEY) || '{}');
        return parseInt(stored[prefix] || 0, 10);
    } catch(e) {
        return 0;
    }
}

function updatePersistentMaxSeq(prefix, seq) {
    try {
        const stored = JSON.parse(localStorage.getItem(HIGHEST_SEQ_STORAGE_KEY) || '{}');
        const curr = parseInt(stored[prefix] || 0, 10);
        if (seq > curr) {
            stored[prefix] = seq;
            localStorage.setItem(HIGHEST_SEQ_STORAGE_KEY, JSON.stringify(stored));
        }
    } catch(e) {}
}

function recordUsedOrderId(orderId) {
    if (!orderId) return;
    try {
        const cleanId = String(orderId).trim();
        let usedIds = JSON.parse(localStorage.getItem(ALL_TIME_ORDER_IDS_KEY) || '[]');
        if (!usedIds.includes(cleanId)) {
            usedIds.push(cleanId);
            localStorage.setItem(ALL_TIME_ORDER_IDS_KEY, JSON.stringify(usedIds));
        }
        if (cleanId.length >= 8) {
            const prefix = cleanId.slice(0, 4);
            const seq = parseInt(cleanId.slice(4), 10);
            if (!isNaN(seq)) updatePersistentMaxSeq(prefix, seq);
        }
    } catch(e) {}
} 

let activeStatusFilters = [];
let totalStatusOptionsCount = 0;
let activeUserFilters = [];
let totalUserOptionsCount = 0;
let isFilterInitialized = false;
let userFilterModified = false;
let statusFilterModified = false;

const DEFAULT_SAMPLE_PRODUCTS = {
    "26010001": [
        { docId: "prod_26_01", orderId: "26010001", type: "جوال", name: "باقة أعمال متميزة 100", qty: 2, sub: 1500.0, serial: "899660260101", mobile: "0501234567", user: "1023456789", status: "مكتمل", date: "14-01-2026", time: "11:25", rowNote: "تم التفعيل وتسليم الشريحة" },
        { docId: "prod_26_02", orderId: "26010001", type: "بيانات", name: "شريحة بيانات 5G مفتوحة", qty: 1, sub: 2500.0, serial: "899660260102", mobile: "0507654321", user: "1023456789", status: "مكتمل", date: "14-01-2026", time: "12:10", rowNote: "جاهز للاستخدام" },
        { docId: "prod_26_03", orderId: "26010001", type: "جوال", name: "باقة اتصال مرن 50", qty: 2, sub: 300.0, serial: "899660260103", mobile: "0509876543", user: "1023456789", status: "معلق", date: "15-01-2026", time: "15:45", rowNote: "بانتظار توثيق نفاذ" }
    ],
    "26010002": [
        { docId: "prod_26_11", orderId: "26010002", type: "فايبر", name: "فايبر أعمال 500 ميجا", qty: 1, sub: 3500.0, sai: "SAI-RYD-042", coords: "24.7136, 46.6753", city: "الرياض", status: "مكتمل", date: "20-01-2026", time: "10:15", rowNote: "تم التركيب والتشغيل" },
        { docId: "prod_26_12", orderId: "26010002", type: "DIA", name: "خط ربط مخصص Dedicated 100M", qty: 1, sub: 2200.0, sai: "SAI-JED-011", coords: "21.5433, 39.1728", city: "جدة", status: "معلق", date: "21-01-2026", time: "14:20", rowNote: "بانتظار تمديد الكيبل الداخلي" }
    ],
    "26010003": [
        { docId: "prod_26_21", orderId: "26010003", type: "SIP Trunk", name: "قنوات اتصال صوتي SIP 30", qty: 1, sub: 4800.0, sai: "SIP-RYD-001", coords: "24.7742, 46.7385", city: "الرياض", status: "مكتمل", date: "28-01-2026", time: "16:05", rowNote: "تم ربط السنترال بنجاح" }
    ],
    "26020001": [
        { docId: "prod_26_31", orderId: "26020001", type: "فايبر", name: "عقد صيانة وتجهيز شبكات", qty: 1, sub: 4000.0, sai: "SAI-DMM-005", coords: "26.4207, 50.0888", city: "الدمام", status: "فقدان", date: "05-02-2026", time: "09:30", rowNote: "إلغاء لعدم الاتفاق" }
    ],
    "26020002": [
        { docId: "prod_26_41", orderId: "26020002", type: "بيانات", name: "أجهزة راوتر 5G أعمال", qty: 5, sub: 300.0, serial: "899660260201", mobile: "0561122334", user: "1045678901", status: "مكتمل", date: "12-02-2026", time: "11:00", rowNote: "تم التسليم" },
        { docId: "prod_26_42", orderId: "26020002", type: "جوال", name: "شرائح بيانات 5G مفتوحة", qty: 4, sub: 450.0, serial: "899660260202", mobile: "0561122335", user: "1045678902", status: "معلق", date: "12-02-2026", time: "11:30", rowNote: "بانتظار السداد" }
    ],
    "26030001": [
        { docId: "prod_26_51", orderId: "26030001", type: "DIA", name: "خطوط ربط رئيسية Dedicated", qty: 1, sub: 9500.0, sai: "SAI-RYD-099", coords: "24.7136, 46.6753", city: "الرياض", status: "مكتمل", date: "10-03-2026", time: "10:00", rowNote: "تم التفعيل بنجاح" },
        { docId: "prod_26_52", orderId: "26030001", type: "SIP Trunk", name: "باقات سنترال سحابي متقدم", qty: 2, sub: 1250.0, sai: "SIP-RYD-044", coords: "24.7136, 46.6753", city: "الرياض", status: "معلق", date: "10-03-2026", time: "10:30", rowNote: "بانتظار موافقة العميل" }
    ],
    "26030002": [
        { docId: "prod_26_61", orderId: "26030002", type: "فايبر", name: "فايبر أعمال مخصص 1 جيجا", qty: 1, sub: 6200.0, sai: "SAI-JED-088", coords: "21.5433, 39.1728", city: "جدة", status: "مكتمل", date: "22-03-2026", time: "13:00", rowNote: "تم التركيب والتشغيل" },
        { docId: "prod_26_62", orderId: "26030002", type: "جوال", name: "باقات هاتف أعمال متكاملة", qty: 2, sub: 1550.0, serial: "899660260301", mobile: "0559988776", user: "1088776655", status: "معلق", date: "22-03-2026", time: "13:30", rowNote: "بانتظار توثيق نفاذ" }
    ],
    "26040001": [
        { docId: "prod_26_71", orderId: "26040001", type: "DIA", name: "شبكة بيانات سحابية متقدمة", qty: 1, sub: 7800.0, sai: "SAI-RYD-102", coords: "24.7136, 46.6753", city: "الرياض", status: "مكتمل", date: "04-04-2026", time: "14:00", rowNote: "تم التشغيل بنجاح" },
        { docId: "prod_26_72", orderId: "26040001", type: "جوال", name: "باقات أعمال إضافية", qty: 2, sub: 900.0, serial: "899660260401", mobile: "0544332211", user: "1099887766", status: "معلق", date: "04-04-2026", time: "14:30", rowNote: "بانتظار تفعيل الخدمة" }
    ],
    "25010001": [
        { docId: "prod_01", orderId: "25010001", type: "جوال", name: "باقة أعمال متميزة 100", qty: 2, sub: 150.0, serial: "8996601002341", mobile: "0501234567", user: "1023456789", status: "مكتمل", date: "14-01-2025", time: "11:25", rowNote: "تم التفعيل وتسليم الشريحة" },
        { docId: "prod_02", orderId: "25010001", type: "بيانات", name: "شريحة بيانات 5G مفتوحة", qty: 1, sub: 350.0, serial: "8996601002342", mobile: "0507654321", user: "1023456789", status: "مكتمل", date: "14-01-2025", time: "12:10", rowNote: "جاهز للاستخدام" },
        { docId: "prod_03", orderId: "25010001", type: "جوال", name: "باقة اتصال مرن 50", qty: 3, sub: 75.0, serial: "8996601002343", mobile: "0509876543", user: "1023456789", status: "معلق", date: "15-01-2025", time: "15:45", rowNote: "بانتظار توثيق نفاذ" },
        { docId: "prod_04", orderId: "25010001", type: "جوال", name: "باقة هاتف إضافية", qty: 1, sub: 50.0, serial: "8996601002344", mobile: "0503344556", user: "1023456789", status: "فقدان", date: "16-01-2025", time: "09:30", rowNote: "تم الإلغاء لعدم السداد" }
    ],
    "25010002": [
        { docId: "prod_11", orderId: "25010002", type: "فايبر", name: "فايبر أعمال 500 ميجا", qty: 1, sub: 1200.0, sai: "SAI-RYD-042", coords: "24.7136, 46.6753", city: "الرياض", status: "معلق", date: "20-01-2025", time: "10:15", rowNote: "بانتظار تمديد الكيبل الداخلي" },
        { docId: "prod_12", orderId: "25010002", type: "DIA", name: "خط ربط مخصص Dedicated 100M", qty: 1, sub: 3500.0, sai: "SAI-JED-011", coords: "21.5433, 39.1728", city: "جدة", status: "مكتمل", date: "21-01-2025", time: "14:20", rowNote: "تم التركيب والتشغيل بنجاح" }
    ],
    "25010003": [
        { docId: "prod_21", orderId: "25010003", type: "SIP Trunk", name: "قنوات اتصال صوتي SIP 30", qty: 1, sub: 1800.0, sai: "SIP-RYD-001", coords: "24.7742, 46.7385", city: "الرياض", status: "مكتمل", date: "28-01-2026", time: "16:05", rowNote: "تم ربط السنترال بنجاح" }
    ]
};

const DEFAULT_SAMPLE_SALES = [
    {
        id: "26010001",
        type: "توريد وتجهيز خطوط أعمال فايبر وسنترال",
        date: "14-01-2026",
        comp: "شركة الأفق للحلول الرقمية",
        cr: "1010345678",
        status: "مكتمل",
        lastModifiedDate: "14-01-2026",
        owner: "أحمد الحربي",
        completedSum: 4000.0,
        pendingSum: 600.0
    },
    {
        id: "26010002",
        type: "ربط فروع مستشفيات وشبكة بيانات مخصصة",
        date: "20-01-2026",
        comp: "مستشفى الرعاية المتقدمة",
        cr: "4030112233",
        status: "معلق",
        lastModifiedDate: "20-01-2026",
        owner: "محمد القحطاني",
        completedSum: 3500.0,
        pendingSum: 2200.0
    },
    {
        id: "26010003",
        type: "قنوات اتصال صوتي SIP Trunk وباقات أعمال",
        date: "28-01-2026",
        comp: "شركة الرواد للتقنية",
        cr: "1010998877",
        status: "مكتمل",
        lastModifiedDate: "28-01-2026",
        owner: "أحمد الحربي",
        completedSum: 4800.0,
        pendingSum: 0.0
    },
    {
        id: "26020001",
        type: "عقد صيانة وتجهيز شبكات داخلية",
        date: "05-02-2026",
        comp: "مجموعة البناء الحديث",
        cr: "2050987654",
        status: "فقدان",
        lastModifiedDate: "05-02-2026",
        owner: "خالد الشمري",
        completedSum: 0.0,
        pendingSum: 0.0
    },
    {
        id: "26020002",
        type: "شرائح بيانات 5G مفتوحة وأجهزة راوتر",
        date: "12-02-2026",
        comp: "مؤسسة الابتكار للتجارة",
        cr: "4650334455",
        status: "معلق",
        lastModifiedDate: "12-02-2026",
        owner: "سارة العتيبي",
        completedSum: 1500.0,
        pendingSum: 1800.0
    },
    {
        id: "26030001",
        type: "حلول سحابية متقدمة وخطوط ربط رئيسية",
        date: "10-03-2026",
        comp: "شركة المدار المتطور للاتصالات",
        cr: "1010887766",
        status: "مكتمل",
        lastModifiedDate: "10-03-2026",
        owner: "أحمد الحربي",
        completedSum: 9500.0,
        pendingSum: 2500.0
    },
    {
        id: "26030002",
        type: "باقات هاتف أعمال وخطوط فايبر مخصصة",
        date: "22-03-2026",
        comp: "المركز الطبي التخصصي",
        cr: "4030998811",
        status: "معلق",
        lastModifiedDate: "22-03-2026",
        owner: "محمد القحطاني",
        completedSum: 6200.0,
        pendingSum: 3100.0
    },
    {
        id: "26040001",
        type: "توريد حلول شبكات متقدمة وباقات أعمال",
        date: "04-04-2026",
        comp: "شركة الاتجاهات اللوجستية",
        cr: "1010554433",
        status: "مكتمل",
        lastModifiedDate: "04-04-2026",
        owner: "سارة العتيبي",
        completedSum: 7800.0,
        pendingSum: 1800.0
    },
    {
        id: "25010001",
        type: "توريد وتجهيز خطوط أعمال فايبر وسنترال",
        date: "14-01-2025",
        comp: "شركة الأفق للحلول الرقمية",
        cr: "1010345678",
        status: "مكتمل",
        lastModifiedDate: "14-01-2025",
        owner: "أحمد الحربي",
        completedSum: 650.0,
        pendingSum: 225.0
    },
    {
        id: "25010002",
        type: "ربط فروع مستشفيات وشبكة بيانات مخصصة",
        date: "20-01-2025",
        comp: "مستشفى الرعاية المتقدمة",
        cr: "4030112233",
        status: "معلق",
        lastModifiedDate: "20-01-2025",
        owner: "محمد القحطاني",
        completedSum: 3500.0,
        pendingSum: 1200.0
    },
    {
        id: "25010003",
        type: "قنوات اتصال صوتي SIP Trunk وباقات أعمال",
        date: "28-01-2025",
        comp: "شركة الرواد للتقنية",
        cr: "1010998877",
        status: "مكتمل",
        lastModifiedDate: "28-01-2025",
        owner: "أحمد الحربي",
        completedSum: 1800.0,
        pendingSum: 0.0
    },
    {
        id: "25020001",
        type: "عقد صيانة وتجهيز شبكات داخلية",
        date: "05-02-2025",
        comp: "مجموعة البناء الحديث",
        cr: "2050987654",
        status: "فقدان",
        lastModifiedDate: "05-02-2025",
        owner: "خالد الشمري",
        completedSum: 0.0,
        pendingSum: 0.0
    },
    {
        id: "25020002",
        type: "شرائح بيانات 5G مفتوحة وأجهزة راوتر",
        date: "12-02-2025",
        comp: "مؤسسة الابتكار للتجارة",
        cr: "4650334455",
        status: "جديد",
        lastModifiedDate: "12-02-2025",
        owner: "سارة العتيبي",
        completedSum: 1500.0,
        pendingSum: 1800.0
    }
];

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getTodayFormatted() {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function formatDateDisplay(dateString) {
    if (!dateString || dateString === '---') return '---';
    let cleanDate = String(dateString).trim();
    if (cleanDate.includes('/')) cleanDate = cleanDate.replace(/\//g, '-');
    const parts = cleanDate.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return cleanDate;
}

function parseDateForSort(dateString) {
    if (!dateString || dateString === '---') return 0;
    let cleanDate = String(dateString).trim().replace(/\//g, '-');
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
        else return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
    }
    return 0;
}

function getMonthYearString(dateString) {
    if (!dateString || dateString === '---') return '';
    let cleanDate = String(dateString).trim().replace(/\//g, '-');
    const parts = cleanDate.split('-');
    let dObj;
    if (parts.length === 3) {
        if (parts[0].length === 4) dObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        else dObj = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    } else {
        dObj = new Date(dateString);
    }
    if (!dObj || isNaN(dObj.getTime()) || dObj.getFullYear() < 1970) return '';
    const monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    return `${monthNames[dObj.getMonth()]} ${dObj.getFullYear()}`;
}

function getTimeFormatted() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0');
}

async function addToActivityLog(fieldName, oldVal, newVal, targetName, ownerName = 'المستخدم') {
    const logEntry = createActivityLogEntry({
        page: 'sales',
        fieldName,
        oldVal,
        newVal,
        identifierValue: targetName,
        user: ownerName
    });
    if (!logEntry) return;
    let logs = [];
    try {
        const parsed = JSON.parse(localStorage.getItem(LOGS_KEY) || "[]");
        logs = Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
    } catch (e) {}
    logs.unshift(logEntry);
    logs = logs.slice(0, 100);
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
    renderActivityLog();
    try {
        if (db) await setDoc(doc(db, "sales_activity_logs", logEntry.timestamp.toString()), logEntry);
    } catch (e) {}
}

function renderActivityLog() {
    const list = document.getElementById('activityList');
    if (!list) return;
    let logs = [];
    try {
        const parsed = JSON.parse(localStorage.getItem(LOGS_KEY) || "[]");
        logs = Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
    } catch (e) {}
    list.innerHTML = renderActivityLogsHTML(logs, 'sales');
}

function toggleLogExpansion() {
    const logSection = document.getElementById('activityLogSection');
    const toggleBtn = document.getElementById('toggleExpandBtn');
    if (!logSection || !toggleBtn) return;
    if (logSection.classList.contains('expanded')) {
        logSection.classList.remove('expanded');
        toggleBtn.innerHTML = '<i class="fas fa-expand-alt"></i>';
    } else {
        logSection.classList.add('expanded');
        toggleBtn.innerHTML = '<i class="fas fa-compress-alt"></i>';
    }
}

function listenToSales() {
    loadSalesFromStorage();

    if (!db) return;

    try {
        const salesRef = collection(db, "sales");
        onSnapshot(salesRef, (snapshot) => {
            const salesData = [];
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                data.id = docSnap.id;
                salesData.push(data);
                recordUsedOrderId(data.id);
            });

            if (salesData.length > 0) {
                localStorage.setItem('asgate_sales_db', JSON.stringify(salesData));
            }

            const activeElement = document.activeElement;
            const isEditingTable = activeElement && activeElement.closest('#salesBody');
            if (!isEditingTable && salesData.length > 0) {
                loadSalesFromStorage();
            } else {
                updateHeaderStats();
            }
        }, (error) => {
            console.warn("ملاحظة مزامنة المبيعات السحابية:", error);
            loadSalesFromStorage();
        });

        const salesLogsRef = collection(db, "sales_activity_logs");
        onSnapshot(salesLogsRef, (logsSnap) => {
            if (logsSnap && !logsSnap.empty) {
                const cloudLogs = [];
                logsSnap.forEach((d) => cloudLogs.push(d.data()));
                cloudLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                const trimmed = cloudLogs.slice(0, 100);
                localStorage.setItem(LOGS_KEY, JSON.stringify(trimmed));
                renderActivityLog();
            }
        }, (err) => {
            console.warn("ملاحظة مزامنة سجل نشاط المبيعات السحابي:", err);
        });
    } catch(err) {
        console.warn("Notice: Local mode active for sales:", err);
        loadSalesFromStorage();
    }
}

function getEyeHideIconSvg(size = 20) {
    return `<svg class="eye-icon eye-hide-icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path>
        <circle cx="12" cy="12" r="3.2"></circle>
        <line x1="4" y1="20" x2="20" y2="4"></line>
    </svg>`;
}

function getEyeShowIconSvg(size = 20) {
    return `<svg class="eye-icon eye-show-icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path>
        <circle cx="12" cy="12" r="3.2"></circle>
    </svg>`;
}

function toggleStatsVisibility() {
    const container = document.getElementById('statsContainer');
    const btn = document.getElementById('eyeToggleBtn');
    if (!container || !btn) return;
    const isHidden = container.classList.toggle('blur-active');
    btn.innerHTML = isHidden ? getEyeHideIconSvg(20) : getEyeShowIconSvg(20);
    btn.setAttribute('title', isHidden ? 'إظهار الأرقام' : 'إخفاء الأرقام');
    localStorage.setItem('asgate_sales_stats_hidden', isHidden ? 'true' : 'false');
}

function initStatsVisibility() {
    const isHidden = localStorage.getItem('asgate_sales_stats_hidden') === 'true';
    const container = document.getElementById('statsContainer');
    const btn = document.getElementById('eyeToggleBtn');
    if (!container || !btn) return;
    if (isHidden) {
        container.classList.add('blur-active');
        btn.innerHTML = getEyeHideIconSvg(20);
        btn.setAttribute('title', 'إظهار الأرقام');
    } else {
        btn.innerHTML = getEyeShowIconSvg(20);
        btn.setAttribute('title', 'إخفاء الأرقام');
    }
}

function isRowVisible(row) {
    if (!row) return false;
    if (row.style.display === 'none') return false;
    if (row.classList.contains('hidden')) return false;
    if (row.offsetParent === null && window.getComputedStyle(row).display === 'none') return false;
    return true;
}

function updateMasterCheckboxState() {
    const masterCb = document.querySelector('thead th input.select-check, #masterCheckbox');
    if (!masterCb) return;
    const visibleRows = Array.from(document.querySelectorAll('#salesBody .main-row')).filter(isRowVisible);
    if (visibleRows.length === 0) {
        masterCb.checked = false;
        masterCb.indeterminate = false;
        return;
    }
    const visibleChecks = visibleRows.map(r => r.querySelector('.select-check')).filter(Boolean);
    const checkedCount = visibleChecks.filter(c => c.checked).length;
    if (checkedCount === 0) {
        masterCb.checked = false;
        masterCb.indeterminate = false;
    } else if (checkedCount === visibleChecks.length) {
        masterCb.checked = true;
        masterCb.indeterminate = false;
    } else {
        masterCb.checked = false;
        masterCb.indeterminate = true;
    }
}

function toggleAllCheckboxes(source) {
    const isChecked = !!(source && source.checked);
    const rows = document.querySelectorAll('#salesBody .main-row');
    rows.forEach(row => {
        const chk = row.querySelector('.select-check');
        if (!chk) return;
        if (isRowVisible(row)) chk.checked = isChecked;
        else chk.checked = false;
    });
    updateMasterCheckboxState();
}

function extractRowData(row) {
    if (!row) return null;
    const id = row.dataset.id || (row.cells[1] ? row.cells[1].innerText.replace('#', '').trim() : '');
    const dateInput = row.cells[3] ? row.cells[3].querySelector('input') : null;
    const rawDate = dateInput ? (dateInput.dataset.rawDate || dateInput.value) : getTodayFormatted();
    const modInput = row.querySelector('.last-mod-field') || (row.cells[10] ? row.cells[10].querySelector('input') : null);
    const rawModDate = modInput ? (modInput.dataset.rawDate || modInput.value) : getTodayFormatted();
    const sums = calculateOrderSums(id);
    const noteInput = row.querySelector('.note-input') || (row.cells[7] ? row.cells[7].querySelector('input') : null);
    const ownerInput = row.querySelector('.owner-input') || (row.cells[11] ? row.cells[11].querySelector('input') : null);
    return {
        id: id,
        type: row.cells[2] && row.cells[2].querySelector('input') ? row.cells[2].querySelector('input').value : '',
        date: rawDate,
        comp: row.cells[4] && row.cells[4].querySelector('input') ? row.cells[4].querySelector('input').value : '',
        cr: row.cells[5] && row.cells[5].querySelector('input') ? row.cells[5].querySelector('input').value : '',
        status: row.cells[6] && row.cells[6].querySelector('select') ? row.cells[6].querySelector('select').value : 'جديد',
        note: noteInput ? noteInput.value : '',
        lastModifiedDate: rawModDate || getTodayFormatted(),
        owner: ownerInput ? ownerInput.value : (row.cells[11] && row.cells[11].querySelector('input') ? row.cells[11].querySelector('input').value : 'المستخدم'),
        completedSum: sums.completed,
        pendingSum: sums.pending
    };
}

function debouncedSave(inputElement) {
    if (!inputElement) return;
    const row = inputElement.closest('tr');
    if (!row) return;
    const id = row.dataset.id || row.cells[1].innerText.replace('#', '').trim();

    const currentData = extractRowData(row);
    if (currentData && currentData.id) {
        try {
            let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
            const index = saved.findIndex(item => String(item.id) === String(currentData.id));
            if (index > -1) saved[index] = { ...saved[index], ...currentData };
            else saved.push(currentData);
            localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
            updateHeaderStats();

            // ربط نشاط الطلب بالعميل برقم السجل التجاري وليس بالاسم
            let rawCusts = localStorage.getItem('crm_customers');
            if (rawCusts) {
                let custs = JSON.parse(rawCusts);
                let custChanged = false;
                const nowIso = new Date().toISOString();
                custs.forEach(c => {
                    if (isCustomerMatchedByCr(c, currentData)) {
                        c.lastActivityDate = nowIso;
                        c.updatedAt = nowIso;
                        if (c.status === 'غير نشط' && c.autoDeactivated) {
                            c.status = 'نشط';
                            delete c.autoDeactivated;
                        }
                        custChanged = true;
                    }
                });
                if (custChanged) {
                    localStorage.setItem('crm_customers', JSON.stringify(custs));
                    localStorage.setItem('asgate_customers_cache_v1', JSON.stringify(custs));
                }
            }
        } catch(e){}
    }

    clearTimeout(saveTimeouts[id]);
    saveTimeouts[id] = setTimeout(() => {
        saveSingleRow(inputElement);
        delete saveTimeouts[id];
    }, 600);
}

async function saveSingleRow(inputElement) {
    if (!inputElement) return;
    const r = inputElement.closest('tr');
    if (!r) return;
    const salesData = extractRowData(r);
    if (!salesData || !salesData.id) return;
    const isOwnerField = inputElement.dataset.field === 'المستخدم';

    try {
        let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        const index = saved.findIndex(item => String(item.id) === String(salesData.id));
        if (index > -1) saved[index] = { ...saved[index], ...salesData };
        else saved.push(salesData);
        localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
        updateHeaderStats();

        if (isOwnerField) {
            const prevChecked = new Set(activeUserFilters);
            const newOwner = String(salesData.owner || '').trim();
            if (newOwner && newOwner !== 'المستخدم') prevChecked.add(newOwner);
            if (typeof populateFilters === 'function') {
                const wasAllChecked = prevChecked.size === 0;
                populateFilters();
                if (!wasAllChecked && prevChecked.size > 0) {
                    const cbs = document.querySelectorAll('#userFilterMenu input[type="checkbox"]');
                    cbs.forEach(cb => { if (prevChecked.has(cb.value)) cb.checked = true; });
                    if (typeof applyColumnFilters === 'function') applyColumnFilters();
                }
            }
        }
        if (db) {
            await setDoc(doc(db, "sales", salesData.id), saved[index] || salesData, { merge: true });
        }
    } catch (e) {
        console.warn("إشعار حفظ سحابي:", e);
    }
}

function generateCustomOrderId(optionalList = null) {
    const now = new Date();
    const year = String(now.getFullYear()).slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const prefix = year + month;

    const saved = optionalList || JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    let maxSequence = getPersistentMaxSeq(prefix);

    saved.forEach(item => {
        const idStr = String(item.id || '').trim();
        if (idStr.startsWith(prefix) && idStr.length >= 8) {
            const seq = parseInt(idStr.slice(4), 10);
            if (!isNaN(seq) && seq > maxSequence) maxSequence = seq;
        }
    });

    try {
        const productsDb = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
        Object.keys(productsDb).forEach(idStr => {
            if (idStr.startsWith(prefix) && idStr.length >= 8) {
                const seq = parseInt(idStr.slice(4), 10);
                if (!isNaN(seq) && seq > maxSequence) maxSequence = seq;
            }
        });
    } catch(e) {}

    let usedIds = [];
    try {
        usedIds = JSON.parse(localStorage.getItem(ALL_TIME_ORDER_IDS_KEY) || '[]');
        usedIds.forEach(idStr => {
            if (idStr.startsWith(prefix) && idStr.length >= 8) {
                const seq = parseInt(idStr.slice(4), 10);
                if (!isNaN(seq) && seq > maxSequence) maxSequence = seq;
            }
        });
    } catch(e) {}

    let nextSeq = maxSequence + 1;
    let candidateId = prefix + String(nextSeq).padStart(4, '0');

    while (
        saved.some(item => String(item.id) === candidateId) ||
        usedIds.includes(candidateId)
    ) {
        nextSeq++;
        candidateId = prefix + String(nextSeq).padStart(4, '0');
    }

    updatePersistentMaxSeq(prefix, nextSeq);
    recordUsedOrderId(candidateId);
    return candidateId;
}

function calculateOrderSums(orderId) {
    const productsDb = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    const products = productsDb[orderId] || DEFAULT_SAMPLE_PRODUCTS[orderId] || [];
    let completed = 0, pending = 0;
    
    if (products.length > 0) {
        products.forEach(p => {
            const lineTotal = (parseFloat(p.qty) || 0) * (parseFloat(String(p.sub).replace(/[^\d.]/g, '')) || 0);
            if (p.status === "مكتمل") completed += lineTotal;
            if (p.status === "معلق") pending += lineTotal;
        });
    } else {
        const saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        const ord = saved.find(s => String(s.id) === String(orderId));
        if (ord) {
            completed = parseFloat(ord.completedSum) || 0;
            pending = parseFloat(ord.pendingSum) || 0;
        }
    }

    return { completed, pending };
}

function updateHeaderStats() {
    const saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    const d = new Date();
    const currMonth = String(d.getMonth() + 1).padStart(2, '0');
    const currYear = String(d.getFullYear());
    let totalComp = 0, totalPend = 0, monthCount = 0, monthComp = 0, monthPend = 0;
    saved.forEach(item => {
        const sums = calculateOrderSums(item.id);
        totalComp += sums.completed;
        totalPend += sums.pending;

        const calcDate = (item.lastModifiedDate && item.lastModifiedDate !== '---') ? item.lastModifiedDate : item.date;
        let isThisMonth = false;
        if (calcDate) {
            let cleanDate = String(calcDate).replace(/\//g, '-').trim();
            let parts = cleanDate.split('-');
            if (parts.length === 3) {
                if (parts[0].length === 4) { 
                    if (parts[1] === currMonth && parts[0] === currYear) isThisMonth = true; 
                } else { 
                    if (parts[1] === currMonth && parts[2] === currYear) isThisMonth = true; 
                }
            }
        }
        if (isThisMonth) { 
            monthCount++; 
            monthComp += sums.completed; 
            monthPend += sums.pending; 
        }
    });
    const elTotal = document.getElementById('count-total');
    const elMonthCount = document.getElementById('month-count');
    const elSumComp = document.getElementById('sum-completed');
    const elSumPend = document.getElementById('sum-pending');
    const elMonthComp = document.getElementById('month-completed');
    const elMonthPend = document.getElementById('month-pending');
    if (elTotal) elTotal.innerText = saved.length;
    if (elMonthCount) elMonthCount.innerText = monthCount;
    if (elSumComp) elSumComp.innerText = totalComp.toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (elSumPend) elSumPend.innerText = totalPend.toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (elMonthComp) elMonthComp.innerText = monthComp.toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (elMonthPend) elMonthPend.innerText = monthPend.toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function loadSalesFromStorage() {
    const tbody = document.getElementById('salesBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    try {
        let currentProductsDb = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
        let needsProductsSave = false;
        Object.keys(DEFAULT_SAMPLE_PRODUCTS).forEach(k => {
            if (!currentProductsDb[k]) {
                currentProductsDb[k] = DEFAULT_SAMPLE_PRODUCTS[k];
                needsProductsSave = true;
            }
        });
        if (needsProductsSave) {
            localStorage.setItem('asgate_products_db', JSON.stringify(currentProductsDb));
        }
    } catch(e) {}

    let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    if (!saved || saved.length === 0) {
        saved = DEFAULT_SAMPLE_SALES;
        localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
    }
    
    saved.forEach(item => recordUsedOrderId(item.id));

    saved.sort((a, b) => {
        const diff = parseDateForSort(b.date) - parseDateForSort(a.date);
        if (diff !== 0) return diff;
        return String(b.id || '').localeCompare(String(a.id || ''), undefined, { numeric: true });
    });

    let currentMonthYear = '';
    saved.forEach(obj => {
        const mStr = getMonthYearString(obj.date);
        if (mStr && mStr !== currentMonthYear) {
            currentMonthYear = mStr;
            renderMonthSeparator(currentMonthYear);
        }
        renderTableRow(obj);
    });

    updateHeaderStats();
    populateFilters();
    filterSalesTable();
}

function renderMonthSeparator(monthTitle) {
    const tbody = document.getElementById('salesBody');
    if (!tbody) return;
    const row = tbody.insertRow(-1);
    row.className = 'month-separator-row month-separator';
    row.innerHTML = `<td colspan="12"><div class="sep-text month-badge">${escapeHTML(monthTitle)}</div></td>`;
}

function renderTableRow(obj) {
    const tbody = document.getElementById('salesBody');
    if (!tbody) return;
    const sums = calculateOrderSums(obj.id);
    const row = tbody.insertRow(-1);
    row.className = 'main-row';
    row.id = `row-${obj.id}`;
    row.dataset.id = obj.id;
    if (obj.status === "فقدان") {
        row.classList.add('lost-row', 'row-lost');
    }
    const safeId = escapeHTML(obj.id);
    const safeType = escapeHTML(obj.type || '');
    const safeComp = escapeHTML(obj.comp || '');
    const safeCr = escapeHTML(obj.cr || '');
    const safeNote = escapeHTML(obj.note || '');
    const safeOwner = escapeHTML(obj.owner || 'المستخدم');
    const safeDate = obj.date || getTodayFormatted();
    const displayDate = formatDateDisplay(safeDate);
    const lastModDisplay = formatDateDisplay(obj.lastModifiedDate || '---');

    row.innerHTML = `
        <td><input type="checkbox" class="select-check" data-id="${safeId}"></td>
        <td><a href="order_details.html?id=${safeId}" class="order-link readonly-cell" data-order-id="${safeId}" onclick="openOrderDetails('${safeId}'); return false;">#${safeId}</a></td>
        <td><input type="text" class="excel-input order-name-input" value="${safeType}" data-old="${safeType}" data-field="اسم الطلب" data-comp="${safeComp}" data-id="${safeId}" onfocus="this.dataset.old=this.value" onkeyup="updateDateField(this); debouncedSave(this);" onblur="handleSafeBlur(this)"></td>
        <td><input type="text" class="excel-input date-field readonly-input" value="${displayDate}" readonly tabindex="-1" style="cursor: default; background: transparent; user-select: none;" data-raw-date="${safeDate}" dir="ltr"></td>
        <td class="col-company" title="${safeComp}"><input type="text" class="excel-input company-name-input readonly-input" value="${safeComp}" title="${safeComp}" readonly tabindex="-1" style="cursor: default; background: transparent; user-select: none;" data-field="الشركة" data-comp="${safeComp}" data-id="${safeId}"></td>
        <td><input type="text" class="excel-input readonly-input" value="${safeCr}" readonly tabindex="-1" style="cursor: default; background: transparent; user-select: none;"></td>
        <td><select class="excel-input status-select ${getStatusClass(obj.status)}" data-old="${obj.status || 'جديد'}" data-id="${safeId}" data-comp="${safeComp}" onchange="handleStatusChange(this, '${safeId}', '${safeComp}')"><option value="مكتمل" ${obj.status === 'مكتمل' ? 'selected' : ''}>مكتمل</option><option value="توثيق مستخدم" ${obj.status === 'توثيق مستخدم' ? 'selected' : ''}>توثيق مستخدم</option><option value="توثيق مفوض" ${obj.status === 'توثيق مفوض' ? 'selected' : ''}>توثيق مفوض</option><option value="تركيبات" ${obj.status === 'تركيبات' ? 'selected' : ''}>تركيبات</option><option value="تفعيلات" ${obj.status === 'تفعيلات' ? 'selected' : ''}>تفعيلات</option><option value="استلام ايميل" ${obj.status === 'استلام ايميل' ? 'selected' : ''}>استلام ايميل</option><option value="ارسال ايميل" ${obj.status === 'ارسال ايميل' ? 'selected' : ''}>ارسال ايميل</option><option value="موافقة" ${obj.status === 'موافقة' ? 'selected' : ''}>موافقة</option><option value="جديد" ${obj.status === 'جديد' ? 'selected' : ''}>جديد</option><option value="فقدان" ${obj.status === 'فقدان' ? 'selected' : ''}>فقدان</option></select></td>
        <td class="col-note-cell" data-field="ملاحظة"><input type="text" class="excel-input note-input" value="${safeNote}" placeholder="ملاحظة..." data-old="${safeNote}" data-field="ملاحظة" data-comp="${safeComp}" data-id="${safeId}" onfocus="this.dataset.old=this.value" onkeyup="updateDateField(this); debouncedSave(this);" onblur="handleSafeBlur(this)"></td>
        <td><input type="text" class="excel-input readonly-input" value="${sums.completed.toFixed(2)}" readonly tabindex="-1" style="color:var(--success); font-weight:800; cursor: default; background: transparent; user-select: none;"></td>
        <td><input type="text" class="excel-input readonly-input" value="${sums.pending.toFixed(2)}" readonly tabindex="-1" style="color:var(--danger); font-weight:800; cursor: default; background: transparent; user-select: none;"></td>
        <td><input type="text" class="excel-input readonly-input last-mod-field date-field" value="${lastModDisplay}" readonly tabindex="-1" style="color:var(--text-muted); font-weight:700; text-align: center; cursor: default; background: transparent; user-select: none;" dir="ltr"></td>
        <td><input type="text" class="excel-input owner-input" value="${safeOwner}" data-old="${safeOwner}" data-field="المستخدم" data-comp="${safeComp}" data-id="${safeId}" onfocus="this.dataset.old=this.value" onkeyup="updateDateField(this); debouncedSave(this);" onblur="handleSafeBlur(this)"></td>
    `;
}

function handleSafeBlur(el) {
    if (!el) return;
    const fieldName = el.dataset.field || 'حقل';
    const row = el.closest('tr');
    const comp = el.dataset.comp || (row?.querySelector('.company-name-input')?.value) || '';
    const owner = row?.querySelector('.owner-input')?.value || 'المستخدم';
    const oldVal = el.dataset.old;
    const newVal = el.value;
    if (newVal !== oldVal) {
        addToActivityLog(fieldName, oldVal, newVal, comp, fieldName === 'المستخدم' ? newVal : owner);
        el.dataset.old = newVal;
    }
}

function getStatusClass(status) {
    if (status === 'مكتمل') return 'status-complete';
    if (status === 'توثيق مستخدم') return 'status-user-doc';
    if (status === 'توثيق مفوض') return 'status-auth-doc';
    if (status === 'تركيبات') return 'status-installations';
    if (status === 'تفعيلات') return 'status-activations';
    if (status === 'استلام ايميل') return 'status-email-receive';
    if (status === 'ارسال ايميل') return 'status-email-send';
    if (status === 'موافقة') return 'status-approval';
    if (status === 'جديد') return 'status-new';
    if (status === 'فقدان') return 'status-lost';
    return 'status-default';
}

function handleStatusChange(el, orderId, company) {
    const val = el.value;
    const oldVal = el.dataset.old;
    const row = el.closest('tr');
    const owner = row?.querySelector('.owner-input')?.value || 'المستخدم';
    const comp = company || (row?.querySelector('.company-name-input')?.value) || '';
    el.className = `excel-input status-select ${getStatusClass(val)}`;
    if (val === "فقدان") {
        row.classList.add('lost-row', 'row-lost');
        row.classList.remove('status-lost');
    } else {
        row.classList.remove('lost-row', 'row-lost', 'status-lost');
    }
    addToActivityLog('الحالة', oldVal, val, comp, owner);
    updateDateField(el);
    el.dataset.old = val;
    debouncedSave(el);
}

function updateDateField(inputElement) {
    const row = inputElement.closest('tr');
    if (!row) return;
    const modField = row.querySelector('.last-mod-field');
    if (modField) modField.value = getTodayFormatted();
}

function toggleCustomFilter(event, menuId) {
    event.stopPropagation();
    const targetMenu = document.getElementById(menuId);
    if (!targetMenu) return;
    const wrapper = targetMenu.closest('.custom-filter-wrapper');
    const isAlreadyOpen = targetMenu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu.show').forEach(m => {
        if (m !== targetMenu) {
            m.classList.remove('show');
            const w = m.closest('.custom-filter-wrapper');
            if (w) w.classList.remove('active');
        }
    });
    if (isAlreadyOpen) { targetMenu.classList.remove('show'); if (wrapper) wrapper.classList.remove('active'); }
    else { targetMenu.classList.add('show'); if (wrapper) wrapper.classList.add('active'); }
}

function onFilterItemChange(type) {
    if (type === 'status') statusFilterModified = true;
    if (type === 'user') userFilterModified = true;
    applyColumnFilters();
}

function selectAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    if (menuId === 'statusFilterMenu') statusFilterModified = false;
    if (menuId === 'userFilterMenu') userFilterModified = false;
    applyColumnFilters();
}

function clearAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    if (menuId === 'statusFilterMenu') statusFilterModified = true;
    if (menuId === 'userFilterMenu') userFilterModified = true;
    applyColumnFilters();
}

function populateFilters() {
    const statuses = ["مكتمل", "توثيق مستخدم", "توثيق مفوض", "تركيبات", "تفعيلات", "استلام ايميل", "ارسال ايميل", "موافقة", "جديد", "فقدان"];
    const saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    const usersSet = new Set();
    saved.forEach(item => { const ow = String(item.owner || '').trim(); if (ow && ow !== 'غير محدد') usersSet.add(ow); });
    const users = Array.from(usersSet);
    const statusContainer = document.getElementById('statusFilterItemsContainer');
    if (statusContainer) {
        statusContainer.innerHTML = statuses.map(s => {
            const isChecked = !statusFilterModified || activeStatusFilters.includes(s);
            return `<label class="multi-select-item"><input type="checkbox" value="${escapeHTML(s)}" onchange="onFilterItemChange('status')" ${isChecked ? 'checked' : ''}><span class="custom-cb"><i class="fas fa-check"></i></span><span>${escapeHTML(s)}</span></label>`;
        }).join('');
        totalStatusOptionsCount = statuses.length;
    }
    const userContainer = document.getElementById('userFilterItemsContainer');
    if (userContainer) {
        userContainer.innerHTML = users.map(u => {
            const isChecked = !userFilterModified || activeUserFilters.includes(u);
            return `<label class="multi-select-item"><input type="checkbox" value="${escapeHTML(u)}" onchange="onFilterItemChange('user')" ${isChecked ? 'checked' : ''}><span class="custom-cb"><i class="fas fa-check"></i></span><span>${escapeHTML(u)}</span></label>`;
        }).join('');
        totalUserOptionsCount = users.length;
    }
    isFilterInitialized = true;
    applyColumnFilters();
}

function applyColumnFilters() {
    const statusCheckboxes = document.querySelectorAll('#statusFilterMenu input[type="checkbox"]');
    totalStatusOptionsCount = statusCheckboxes.length;
    const checkedStatuses = [];
    statusCheckboxes.forEach(cb => { if (cb.checked) checkedStatuses.push(cb.value); });
    activeStatusFilters = checkedStatuses;
    const userCheckboxes = document.querySelectorAll('#userFilterMenu input[type="checkbox"]');
    totalUserOptionsCount = userCheckboxes.length;
    const checkedUsers = [];
    userCheckboxes.forEach(cb => { if (cb.checked) checkedUsers.push(cb.value); });
    activeUserFilters = checkedUsers;
    const statusDot = document.getElementById('statusFilterDot');
    if (statusDot) statusDot.style.display = (statusFilterModified && checkedStatuses.length < totalStatusOptionsCount) ? 'inline-block' : 'none';
    const userDot = document.getElementById('userFilterDot');
    if (userDot) userDot.style.display = (userFilterModified && checkedUsers.length < totalUserOptionsCount) ? 'inline-block' : 'none';
    filterSalesTable();
}

function filterSalesTable() {
    const queryEl = document.getElementById('globalSearch');
    const query = queryEl ? queryEl.value.toLowerCase().trim() : '';
    const rows = document.querySelectorAll('#salesBody tr');
    let hasVisibleMainRowsUnderMonth = false;
    let currentMonthRow = null;

    rows.forEach(row => {
        if (row.classList.contains('month-separator-row') || row.classList.contains('month-separator')) {
            if (currentMonthRow) {
                currentMonthRow.style.display = hasVisibleMainRowsUnderMonth ? '' : 'none';
            }
            currentMonthRow = row;
            hasVisibleMainRowsUnderMonth = false;
            return;
        }

        if (!row.classList.contains('main-row')) return;

        const text = row.innerText.toLowerCase();
        const matchGlobal = !query || text.includes(query);
        let matchStatus = true;
        if (statusFilterModified && totalStatusOptionsCount > 0) {
            const statusSelect = row.querySelector('.status-select');
            const status = statusSelect ? statusSelect.value : '';
            matchStatus = activeStatusFilters.includes(status);
        }
        let matchUser = true;
        if (userFilterModified && totalUserOptionsCount > 0) {
            const userInput = row.querySelector('.owner-input') || (row.cells[11] ? row.cells[11].querySelector('input') : null);
            const user = userInput ? userInput.value.trim() : '';
            matchUser = activeUserFilters.includes(user);
        }
        const isMatch = matchGlobal && matchStatus && matchUser;
        row.style.display = isMatch ? '' : 'none';
        if (isMatch) hasVisibleMainRowsUnderMonth = true;
    });

    if (currentMonthRow) {
        currentMonthRow.style.display = hasVisibleMainRowsUnderMonth ? '' : 'none';
    }

    updateMasterCheckboxState();
}

function toggleDropdown(e, btn) {
    e.stopPropagation();
    const menu = btn.nextElementSibling;
    document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    if (menu) menu.classList.toggle('show');
}

window.addEventListener('click', (e) => {
    if (!e.target.closest('.btn-bulk-trigger') && !e.target.closest('.dropdown-menu')) {
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    }
    if (!e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.multi-select-menu.show').forEach(m => {
            m.classList.remove('show');
            const w = m.closest('.custom-filter-wrapper');
            if (w) w.classList.remove('active');
        });
    }
    if (e.target.id === 'orderModal') closeOrderModal();
});

document.addEventListener('change', (e) => {
    if (e.target && e.target.classList.contains('select-check') && e.target.id !== 'masterCheckbox') {
        updateMasterCheckboxState();
    }
});

async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    const selected = Array.from(document.querySelectorAll('#salesBody .main-row .select-check:checked')).filter(chk => isRowVisible(chk.closest('tr')));
    if (action === 'استيراد' || action === 'استيراد من Excel') { const up = document.getElementById('excelUpload'); if (up) up.click(); return; }
    if (action === 'تصدير' || action === 'تصدير إلى Excel') { exportToExcel(); return; }
    if (action === 'طباعة') { window.print(); return; }
    if (selected.length === 0) {
        if (typeof Swal !== 'undefined') Swal.fire({ icon: 'info', text: 'يرجى تحديد صف واحد على الأقل من الصفوف الظاهرة', confirmButtonColor: '#3b82f6' });
        else alert('يرجى تحديد صف');
        return;
    }
    if (action === 'حذف' || action === 'حذف المحدد') {
        let confirmed = false;
        if (typeof Swal !== 'undefined') {
            const result = await Swal.fire({ 
                title: 'تأكيد الحذف؟', 
                text: `سيتم حذف ${selected.length} طلب من الصفوف الظاهرة`, 
                icon: 'warning', 
                showCancelButton: true, 
                confirmButtonColor: '#ef4444', 
                cancelButtonColor: '#94a3b8', 
                confirmButtonText: 'نعم، احذف', 
                cancelButtonText: 'إلغاء' 
            });
            confirmed = result.isConfirmed;
        } else confirmed = confirm(`حذف ${selected.length}؟`);
        
        if (confirmed) {
            let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
            const orderIdsToDelete = [];
            const batch = db ? writeBatch(db) : null;
            let batchCounter = 0;

            for (let chk of selected) {
                const row = chk.closest('tr');
                const orderId = row.dataset.id || row.cells[1].innerText.replace('#', '').trim();
                const compInput = row.cells[4] ? row.cells[4].querySelector('input') : null;
                const comp = compInput ? compInput.value : '';
                orderIdsToDelete.push(orderId);
                
                recordUsedOrderId(orderId);

                if (batch) {
                    batch.delete(doc(db, "sales", orderId));
                    batchCounter++;
                }
                addToActivityLog('إجراء', 'تم حذف الطلب', '', comp);
            }

            try {
                const productsDb = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
                orderIdsToDelete.forEach(id => {
                    delete productsDb[id];
                    localStorage.removeItem('asgate_order_logs_' + id);
                    localStorage.removeItem('asgate_global_notes_' + id);
                });
                localStorage.setItem('asgate_products_db', JSON.stringify(productsDb));
            } catch(e) {}

            if (db && orderIdsToDelete.length > 0) {
                try {
                    for (let delId of orderIdsToDelete) {
                        const prodQ = query(collection(db, "products"), where("orderId", "==", String(delId)));
                        const prodSnap = await getDocs(prodQ);
                        prodSnap.forEach(pDoc => {
                            if (batch) {
                                batch.delete(pDoc.ref);
                                batchCounter++;
                            }
                        });
                    }
                } catch(e) { 
                    console.warn("ملاحظة تنظيف بنود فايربيز للطلب المحذوف:", e); 
                }
            }

            if (batch && batchCounter > 0) {
                try { await batch.commit(); } catch(e) { console.warn(e); }
            }

            saved = saved.filter(item => !orderIdsToDelete.includes(item.id));
            localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
            loadSalesFromStorage();
            if (typeof Swal !== 'undefined') Swal.fire({ icon: 'success', title: 'تم الحذف', showConfirmButton: false, timer: 1500 });
        }
    } else if (action === 'تغيير المستخدم') {
        let newUser = prompt('أدخل اسم المستخدم الجديد:', 'المستخدم');
        if (newUser && newUser.trim()) {
            let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
            const batch = db ? writeBatch(db) : null;
            for (let chk of selected) {
                const row = chk.closest('tr');
                const orderId = row.dataset.id || row.cells[1].innerText.replace('#', '').trim();
                const compInput = row.cells[4] ? row.cells[4].querySelector('input') : null;
                const comp = compInput ? compInput.value : '';
                const item = saved.find(s => String(s.id) === String(orderId));
                if (item) {
                    const oldOwner = item.owner;
                    item.owner = newUser.trim();
                    item.lastModifiedDate = getTodayFormatted();
                    addToActivityLog('المستخدم', oldOwner, newUser.trim(), comp, newUser.trim());
                    if (batch) {
                        batch.update(doc(db, "sales", orderId), { owner: newUser.trim(), lastModifiedDate: getTodayFormatted() });
                    }
                }
            }
            if (batch) {
                try { await batch.commit(); } catch(e){}
            }
            localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
            loadSalesFromStorage();
        }
    }
}

function exportToExcel() {
    const saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    const selectedChecks = Array.from(document.querySelectorAll('#salesBody .main-row .select-check:checked')).filter(chk => isRowVisible(chk.closest('tr')));
    const selectedIds = selectedChecks.map(chk => chk.dataset.id || chk.closest('tr')?.dataset.id).filter(Boolean);
    let dataToExport = [];
    if (selectedIds.length > 0) dataToExport = saved.filter(item => selectedIds.includes(String(item.id)));
    else {
        const visibleRows = Array.from(document.querySelectorAll('#salesBody .main-row')).filter(isRowVisible);
        const visibleIds = visibleRows.map(r => r.dataset.id).filter(Boolean);
        dataToExport = saved.filter(item => visibleIds.includes(String(item.id)));
    }
    if (dataToExport.length === 0) { alert('لا توجد بيانات'); return; }
    const exportData = dataToExport.map(item => ({ "رقم الطلب": item.id, "اسم الطلب": item.type || "", "تاريخ الإنشاء": item.date || "", "الشركة": item.comp || "", "السجل التجاري": item.cr || "", "الحالة": item.status || "", "ملاحظة": item.note || "", "تاريخ التعديل": item.lastModifiedDate || "", "المستخدم": item.owner || "" }));
    if (typeof XLSX !== 'undefined') {
        const worksheet = XLSX.utils.json_to_sheet(exportData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "المبيعات");
        XLSX.writeFile(workbook, "Sales_Export.xlsx");
    }
}

function normalizeExcelDate(val) {
    if (!val) return getTodayFormatted();
    if (typeof val === 'number') {
        const dateObj = new Date(Math.round((val - 25569) * 86400 * 1000));
        return `${String(dateObj.getDate()).padStart(2, '0')}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${dateObj.getFullYear()}`;
    }
    return String(val).trim().replace(/\//g, '-');
}

async function handleExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (typeof XLSX === 'undefined') { alert('مكتبة الإكسيل غير محملة'); return; }
    if (typeof Swal !== 'undefined') Swal.fire({ title: 'جاري استيراد البيانات...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); } });
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
            if (jsonData.length === 0) { if (typeof Swal !== 'undefined') Swal.close(); alert('الملف فارغ'); return; }
            let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
            let batch = db ? writeBatch(db) : null;
            let batchCounter = 0;
            for (let row of jsonData) {
                const rawId = String(row['رقم الطلب'] || row['id'] || '').trim();
                const newId = rawId || generateCustomOrderId(saved);
                const newOrder = { id: newId, type: String(row['اسم الطلب'] || row['type'] || '').trim(), date: normalizeExcelDate(row['تاريخ الإنشاء'] || row['date'] || ''), comp: String(row['الشركة'] || row['comp'] || '').trim(), cr: String(row['السجل التجاري'] || row['السجل الرئيسي'] || row['السجل'] || '').trim(), status: String(row['الحالة'] || 'جديد').trim(), note: String(row['ملاحظة'] || row['note'] || '').trim(), lastModifiedDate: getTodayFormatted(), owner: String(row['المستخدم'] || 'المستخدم').trim(), notes: JSON.stringify([]) };
                const existingIndex = saved.findIndex(s => String(s.id) === String(newId));
                if (existingIndex > -1) saved[existingIndex] = { ...saved[existingIndex], ...newOrder };
                else saved.unshift(newOrder);
                if (batch && db) {
                    const docRef = doc(db, "sales", String(newId));
                    batch.set(docRef, newOrder, { merge: true });
                    batchCounter++;
                    if (batchCounter >= 400) { try { await batch.commit(); } catch (e) {} batch = writeBatch(db); batchCounter = 0; }
                }
            }
            if (batch) { try { await batch.commit(); } catch (e) {} }
            localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
            loadSalesFromStorage();
            if (typeof Swal !== 'undefined') Swal.fire({ icon: 'success', title: 'اكتمل الاستيراد', text: `تم استيراد ${jsonData.length} سجل بنجاح`, timer: 2000 });
        } catch (err) { console.error(err); if (typeof Swal !== 'undefined') Swal.close(); alert('خطأ: ' + err.message); }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = '';
}

function openOrderModal() { const modal = document.getElementById('orderModal'); if (modal) modal.style.display = 'flex'; }
function closeOrderModal() {
    const modal = document.getElementById('orderModal');
    if (modal) modal.style.display = 'none';
    ['mSearchField', 'mType', 'mComp', 'mCr'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const resDiv = document.getElementById('mResults'); if (resDiv) resDiv.style.display = 'none';
}

function searchCustomerInModal(el) {
    const query = el.value.toLowerCase().trim();
    const resDiv = document.getElementById('mResults');
    const customers = JSON.parse(localStorage.getItem(CUSTOMERS_STORAGE_KEY) || '[]');
    if (query.length < 1) { if (resDiv) resDiv.style.display = 'none'; return; }
    
    // البحث بالاسم أو السجل التجاري
    const filtered = customers.filter(c => { 
        const cName = (c.comp || c.name || "").toLowerCase(); 
        const crVal = (c.cr || c.cr1 || ""); 
        return cName.includes(query) || crVal.includes(query); 
    });
    
    if (resDiv) {
        if (filtered.length === 0) resDiv.innerHTML = '<div style="color:#94a3b8; text-align:center; padding: 10px;">لا توجد نتائج مطابقة للبحث</div>';
        else {
            resDiv.innerHTML = filtered.map(c => { 
                const compName = c.comp || c.name || ''; 
                const displayCr = c.cr || c.cr1 || ''; 
                return `<div class="customer-result-item" data-comp="${escapeHTML(compName)}" data-cr="${escapeHTML(displayCr)}">${escapeHTML(compName)} - ${escapeHTML(displayCr || 'بدون سجل تجاري')}</div>`; 
            }).join('');
            resDiv.querySelectorAll('.customer-result-item').forEach(item => { 
                item.onclick = () => { selectCustomer(item.dataset.comp, item.dataset.cr); }; 
            });
        }
        resDiv.style.display = 'block';
    }
}

function selectCustomer(comp, cr) {
    const mComp = document.getElementById('mComp'); 
    const mCr = document.getElementById('mCr'); 
    const resDiv = document.getElementById('mResults'); 
    const searchField = document.getElementById('mSearchField');
    if (mComp) mComp.value = comp || ''; 
    if (mCr) mCr.value = cr || ''; 
    if (resDiv) resDiv.style.display = 'none'; 
    if (searchField) searchField.value = comp || '';
}

async function addOrderRow() {
    const type = document.getElementById('mType').value.trim();
    const comp = document.getElementById('mComp').value.trim();
    const cr = document.getElementById('mCr').value.trim();
    if (!type || !comp) { 
        if (typeof Swal !== 'undefined') Swal.fire({ icon: 'warning', text: 'يرجى اختيار العميل وإدخال اسم الطلب', confirmButtonColor: '#3b82f6' }); 
        else alert('يرجى اختيار العميل وإدخال اسم الطلب'); 
        return; 
    }
    const newId = generateCustomOrderId();
    
    try {
        const productsDb = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
        productsDb[newId] = [];
        localStorage.setItem('asgate_products_db', JSON.stringify(productsDb));
        localStorage.removeItem('asgate_order_logs_' + newId);
        localStorage.removeItem('asgate_global_notes_' + newId);
    } catch(e) {}

    const today = getTodayFormatted();
    const newOrder = { 
        id: newId, 
        type: type, 
        date: today, 
        comp: comp, 
        cr: cr, 
        status: 'جديد', 
        note: '',
        lastModifiedDate: today, 
        owner: 'المستخدم',
        completedSum: 0,
        pendingSum: 0
    };

    let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    saved.unshift(newOrder);
    localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
    loadSalesFromStorage();
    try {
        if (db) await setDoc(doc(db, "sales", newId), newOrder);
        addToActivityLog('إجراء', 'تم إنشاء طلب جديد', '', comp);
        closeOrderModal();
        if (typeof Swal !== 'undefined') Swal.fire({ icon: 'success', title: 'تم الإنشاء', text: `تم إنشاء الطلب #${newId}`, timer: 2000, showConfirmButton: false });
    } catch (e) { console.warn(e); closeOrderModal(); }
}

function openOrderDetails(orderId) {
    if (!orderId) return;
    localStorage.setItem('current_order_id', String(orderId));
    window.location.href = `order_details.html?id=${encodeURIComponent(String(orderId))}`;
}

function initNoteHoverTooltip() {
    let tooltip = document.getElementById('salesNoteTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'salesNoteTooltip';
        tooltip.className = 'sales-note-popover';
        document.body.appendChild(tooltip);
    }

    let activeCell = null;

    function updateTooltipPosition(cell) {
        if (!cell || !tooltip.classList.contains('visible')) return;
        const rect = cell.getBoundingClientRect();
        const tipWidth = tooltip.offsetWidth;
        const tipHeight = tooltip.offsetHeight;

        let top = rect.top - tipHeight - 8;
        let arrowClass = 'arrow-bottom';

        if (top < 10) {
            top = rect.bottom + 8;
            arrowClass = 'arrow-top';
        }

        let left = rect.left + (rect.width / 2) - (tipWidth / 2);
        const padding = 10;
        if (left < padding) left = padding;
        if (left + tipWidth > window.innerWidth - padding) {
            left = window.innerWidth - tipWidth - padding;
        }

        tooltip.style.top = `${Math.round(top)}px`;
        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.classList.remove('arrow-top', 'arrow-bottom');
        tooltip.classList.add(arrowClass);
    }

    function showTooltipFor(target) {
        const cell = target.closest('.col-note-cell, td:nth-child(8)');
        if (!cell) return;
        const mainRow = cell.closest('tr.main-row');
        if (!mainRow) return;

        activeCell = cell;
        const input = cell.querySelector('.note-input') || cell.querySelector('input');
        const text = input ? input.value.trim() : cell.innerText.trim();
        const orderId = mainRow.dataset.id || (mainRow.cells[1] ? mainRow.cells[1].innerText.replace('#', '').trim() : '');

        let contentHtml = '';
        if (text) {
            contentHtml = `<div class="popover-header"><i class="fas fa-sticky-note"></i> ملاحظة الطلب #${escapeHTML(orderId)}</div><div class="popover-body">${escapeHTML(text)}</div>`;
        } else {
            contentHtml = `<div class="popover-header"><i class="fas fa-sticky-note"></i> ملاحظة الطلب #${escapeHTML(orderId)}</div><div class="popover-body empty"><i class="fas fa-info-circle"></i> لا توجد ملاحظة مدونة</div>`;
        }

        tooltip.innerHTML = contentHtml;
        tooltip.classList.add('visible');
        updateTooltipPosition(cell);
    }

    function hideTooltip() {
        activeCell = null;
        tooltip.classList.remove('visible');
    }

    const table = document.getElementById('salesTable');
    if (table) {
        table.addEventListener('mouseover', (e) => {
            const cell = e.target.closest('.col-note-cell, td:nth-child(8)');
            if (cell && cell !== activeCell) {
                showTooltipFor(cell);
            } else if (!cell && activeCell) {
                hideTooltip();
            }
        });

        table.addEventListener('mouseout', (e) => {
            const related = e.relatedTarget;
            if (activeCell && (!related || !activeCell.contains(related))) {
                hideTooltip();
            }
        });

        table.addEventListener('input', (e) => {
            if (e.target && e.target.classList.contains('note-input') && activeCell && activeCell.contains(e.target)) {
                showTooltipFor(activeCell);
            }
        });
    }

    const tableWrapper = document.querySelector('.table-wrapper');
    if (tableWrapper) {
        tableWrapper.addEventListener('scroll', hideTooltip, { passive: true });
    }
    window.addEventListener('scroll', hideTooltip, { passive: true });
}

async function initPage() {
    initStatsVisibility();
    listenToSales();
    renderActivityLog();
    initNoteHoverTooltip();
    const urlParams = new URLSearchParams(window.location.search);
    const highlightId = urlParams.get('highlight');
    if (highlightId && typeof window.triggerElementHighlight === 'function') {
        setTimeout(() => window.triggerElementHighlight(highlightId), 400);
    }
}

Object.assign(window, {
    initPage, toggleStatsVisibility, debouncedSave, saveSingleRow, toggleLogExpansion, addToActivityLog, renderActivityLog, filterSalesTable, debouncedFilterTable: filterSalesTable, toggleDropdown, toggleAllCheckboxes, handleBulkAction, handleExcelImport, openOrderModal, closeOrderModal, searchCustomerInModal, selectCustomer, addOrderRow, handleStatusChange, handleSafeBlur, updateDateField, toggleCustomFilter, selectAllFilter, clearAllFilter, applyColumnFilters, onFilterItemChange, updateMasterCheckboxState, openOrderDetails, initNoteHoverTooltip
});

document.addEventListener('DOMContentLoaded', () => { initPage(); });
