// ==========================================
// main.js - لوحة القيادة الرئيسية (نظام ASGate CRM)
// استراتيجية ترشيد كوتا فايربيز (Zero-Waste Firebase Quota):
// 1. تحميل فوري للبيانات من الذاكرة المحلية (localStorage) لحظة فتح الصفحة (0 ثانية، 0 قراءات)
// 2. تحديث لوحة التحكم والرسوم البيانية والإحصائيات مباشرة بدون أي انتظار
// 3. مزامنة لحظية في الخلفية عبر Firestore onSnapshot لتلقي أي تحديثات جديدة
// 4. حفظ وتحديث الكاش المحلي تلقائياً لتقليل استهلاك الكوتا
// ==========================================
import Chart from 'chart.js/auto';
window.Chart = Chart;

import { db, collection, onSnapshot, doc, setDoc } from './firebase-config.js';

// مفاتيح التخزين المؤقت الموحدة لجميع صفحات النظام
const CACHE_KEYS = {
    VISITS: 'asgate_visits_local_cache_v1',
    OPPORTUNITIES: 'asgate_opportunities_local_cache_v1',
    SALES: 'asgate_sales_db',
    CUSTOMERS: 'crm_customers',
    PRODUCTS: 'asgate_products_db',
    TARGETS: 'monthlyTargets'
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
    }
];

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
    ]
};

// --- الحالة العامة ---
let firestoreRawData = { visits: [], opportunities: [], sales: [], customers: [] };
let productsDb = {};
let achievedChart, gaugeChart, pendingChart, staffChart;
let q1Chart, q2Chart, q3Chart, q4Chart;
let monthlyTrendChart;
let isEditingTargets = false;
const defaultMonthlyTarget = 15000;
let monthlyTargetsArr = Array(12).fill(defaultMonthlyTarget);

const monthsNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
let oppCountEl, visitCountEl, salesValueEl, pendingValueEl, tbody;
let isInitialMonthLoaded = false;

const COMPLETED_TIERS = [0, 5000, 8000, 12000, 15000, 20000, 50000, 100000, 150000, 250000, 500000];
const COUNT_TIERS = [0, 50, 80, 120, 150, 200, 500, 1000, 1500, 2500, 5000];

function mapValueToTierPosition(val, tiers) {
    if (val <= 0 || isNaN(val)) return 0;
    if (val >= tiers[tiers.length - 1]) {
        const lastIdx = tiers.length - 1;
        const lastDiff = tiers[lastIdx] - tiers[lastIdx - 1];
        return lastIdx + (val - tiers[lastIdx]) / (lastDiff || 1);
    }
    for (let i = 0; i < tiers.length - 1; i++) {
        const lower = tiers[i];
        const upper = tiers[i + 1];
        if (val >= lower && val <= upper) {
            const fraction = (val - lower) / (upper - lower);
            return i + fraction;
        }
    }
    return 0;
}

function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try { fn(...args); } catch (err) { console.error("Debounce error:", err); }
        }, delay);
    };
}

function parseDateParts(dateVal) {
    if (!dateVal && dateVal !== 0) return { day: null, month: null, year: null };
    let d = null;
    try {
        if (typeof dateVal === 'number' && dateVal > 1000 && dateVal < 60000) {
            d = new Date((dateVal - 25569) * 86400 * 1000);
        } else if (typeof dateVal.toDate === 'function') d = dateVal.toDate();
        else if (dateVal && typeof dateVal === 'object' && dateVal.seconds) d = new Date(dateVal.seconds * 1000);
        else if (dateVal instanceof Date) d = dateVal;
        else if (typeof dateVal === 'string') {
            const clean = dateVal.trim();
            if (clean.includes('T')) d = new Date(clean);
            else {
                const parts = clean.split(' ')[0].split(/[-/]/);
                if (parts.length === 3) {
                    let [p0, p1, p2] = parts;
                    if (p0.length === 4) return { year: p0, month: p1.padStart(2, '0'), day: p2.padStart(2, '0') };
                    else if (p2.length === 4) return { year: p2, month: p1.padStart(2, '0'), day: p0.padStart(2, '0') };
                    else if (p0.length === 2 && p2.length === 2) {
                        let y = parseInt(p2, 10);
                        return { year: (y > 50 ? "19" : "20") + p2, month: p1.padStart(2, '0'), day: p0.padStart(2, '0') };
                    }
                }
                d = new Date(clean);
            }
        }
        if (d && !isNaN(d.getTime())) {
            return { year: d.getFullYear().toString(), month: (d.getMonth() + 1).toString().padStart(2, '0'), day: d.getDate().toString().padStart(2, '0') };
        }
    } catch(e) {}
    return { day: null, month: null, year: null };
}

function parseMonthFromDate(dateStr) { return parseDateParts(dateStr).month; }
function parseYearFromDate(dateStr) { return parseDateParts(dateStr).year; }

function getItemDate(item, isSale = false) {
    if (!item) return '';
    if (isSale) {
        return (item.lastModifiedDate && item.lastModifiedDate !== '---')
            ? item.lastModifiedDate
            : (item.date || item.saleDate || item.createdAt || item.orderDate || '');
    }
    return item.visitDate || item.oppDate || item.date || item.createdAt || item.expDate || item.editDate || '';
}

function calculateOrderFinancials(order, orderProducts = []) {
    let completedSum = 0;
    let pendingSum = 0;

    if (orderProducts && orderProducts.length > 0) {
        orderProducts.forEach(p => {
            const qty = parseFloat(p.qty) || 1;
            const sub = parseFloat(String(p.sub !== undefined ? p.sub : (p.price || 0)).replace(/[^\d.]/g, '')) || 0;
            const lineTotal = qty * sub;
            const pStatus = (p.status || '').trim();
            if (pStatus === 'مكتمل') {
                completedSum += lineTotal;
            } else if (pStatus === 'معلق' || pStatus === 'جديد' || pStatus === 'متابعة' || pStatus === 'عرض سعر') {
                pendingSum += lineTotal;
            }
        });
    }

    if (completedSum === 0 && pendingSum === 0) {
        if (order.completedSum !== undefined || order.pendingSum !== undefined) {
            completedSum = parseFloat(order.completedSum) || 0;
            pendingSum = parseFloat(order.pendingSum) || 0;
        } else if (order.completed !== undefined || order.pending !== undefined) {
            completedSum = parseFloat(order.completed) || 0;
            pendingSum = parseFloat(order.pending) || 0;
        } else {
            const orderTotal = parseFloat(String(order.totalSales || order.total || order.amount || order.value || order.oppValue || 0).replace(/[^\d.]/g, '')) || 0;
            const status = (order.status || '').trim();
            if (status === 'مكتمل') {
                completedSum = orderTotal;
            } else if (['معلق', 'جديد', 'توثيق مستخدم', 'توثيق مفوض', 'تركيبات', 'تفعيلات', 'استلام ايميل', 'ارسال ايميل', 'موافقة'].includes(status)) {
                pendingSum = orderTotal;
            }
        }
    }

    return { completedSum, pendingSum };
}

function getStoredTargets() {
    try {
        const saved = localStorage.getItem(CACHE_KEYS.TARGETS);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length === 12) return parsed;
        }
    } catch (e) { console.warn("LocalStorage issue:", e); }
    return monthlyTargetsArr;
}

const saveTargetsToFirestore = debounce(async (targetsArr) => {
    updateSyncStatus('saving');
    try {
        if (db) {
            await setDoc(doc(db, "settings", "monthlyTargets"), { values: targetsArr, updatedAt: new Date().toISOString() }, { merge: true });
        }
        updateSyncStatus('saved');
    } catch (e) {
        updateSyncStatus('saved');
    }
}, 800);

function saveStoredTargets(targetsArr) {
    monthlyTargetsArr = targetsArr;
    try { localStorage.setItem(CACHE_KEYS.TARGETS, JSON.stringify(targetsArr)); } catch (e) {}
    saveTargetsToFirestore(targetsArr);
}

function updateSyncStatus(status) {
    const statusEl = document.getElementById('syncStatus');
    if (!statusEl) return;
    statusEl.classList.remove('sync-saving','sync-saved','sync-loading','sync-error');
    switch(status) {
        case 'saving': statusEl.textContent = 'جاري الحفظ...'; statusEl.classList.add('sync-saving'); break;
        case 'saved': statusEl.textContent = 'تم الحفظ'; statusEl.classList.add('sync-saved'); setTimeout(()=>{ statusEl.textContent=''; statusEl.classList.remove('sync-saved'); }, 3000); break;
        case 'loading': statusEl.textContent = 'مزامنة لحظية...'; statusEl.classList.add('sync-loading'); break;
        case 'error': statusEl.textContent = 'وضع التخزين الآمن'; statusEl.classList.add('sync-saved'); break;
        default: statusEl.textContent = ''; break;
    }
}

function safeArrayFromStorage(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') return Object.values(parsed);
    } catch(e) {}
    return [];
}

function loadDataFromLocalCache() {
    try {
        let opps = safeArrayFromStorage(CACHE_KEYS.OPPORTUNITIES);
        let visits = safeArrayFromStorage(CACHE_KEYS.VISITS);
        let sales = safeArrayFromStorage(CACHE_KEYS.SALES);
        const customers = safeArrayFromStorage(CACHE_KEYS.CUSTOMERS);
        
        if (!opps || opps.length === 0) {
            opps = [
                { id: "opp_001", comp: "شركة الأفق للحلول الرقمية", oppDate: "10-01-2026", curServ: "سنترال سحابي", oppValue: "15000", status: "مهتم", owner: "أحمد الحربي" },
                { id: "opp_002", comp: "مجموعة البناء الحديث", oppDate: "15-02-2026", curServ: "ربط فروع IPVPN", oppValue: "28000", status: "رابح", owner: "خالد الشمري" },
                { id: "opp_003", comp: "مستشفى الرعاية المتقدمة", oppDate: "20-03-2026", curServ: "فايبر نت أعمال", oppValue: "9500", status: "مهتم", owner: "محمد القحطاني" },
                { id: "opp_004", comp: "شركة الرواد للتقنية", oppDate: "05-04-2026", curServ: "SIP Trunk", oppValue: "6000", status: "مهتم", owner: "أحمد الحربي" }
            ];
            try { 
                let cacheObj = {};
                opps.forEach(o => { cacheObj[o.id] = o; });
                localStorage.setItem(CACHE_KEYS.OPPORTUNITIES, JSON.stringify(cacheObj)); 
            } catch(e){}
        }

        if (!visits || visits.length === 0) {
            visits = [
                { id: "visit_001", comp: "شركة الأفق للحلول الرقمية", visitDate: "14-01-2026", curServ: "سنترال سحابي", oppValue: "5000", status: "مميزة", owner: "أحمد الحربي" },
                { id: "visit_002", comp: "مستشفى الرعاية المتقدمة", visitDate: "20-01-2026", curServ: "ربط فروع", oppValue: "12000", status: "متابعة", owner: "محمد القحطاني" },
                { id: "visit_003", comp: "مجموعة البناء الحديث", visitDate: "05-02-2026", curServ: "كاميرات مراقبة", oppValue: "0", status: "غير مهتم", owner: "خالد الشمري" },
                { id: "visit_004", comp: "مؤسسة الابتكار للتجارة", visitDate: "12-02-2026", curServ: "نقاط بيع", oppValue: "0", status: "فقدان", owner: "سارة العتيبي" },
                { id: "visit_005", comp: "شركة المدار المتطور للاتصالات", visitDate: "10-03-2026", curServ: "فايبر أعمال", oppValue: "18000", status: "مميزة", owner: "أحمد الحربي" },
                { id: "visit_006", comp: "المركز الطبي التخصصي", visitDate: "22-03-2026", curServ: "سنترال وباقات", oppValue: "9000", status: "متابعة", owner: "محمد القحطاني" },
                { id: "visit_007", comp: "شركة الاتجاهات اللوجستية", visitDate: "04-04-2026", curServ: "شبكات سحابية", oppValue: "7800", status: "مميزة", owner: "سارة العتيبي" }
            ];
            try { 
                let cacheObj = {};
                visits.forEach(v => { cacheObj[v.id] = v; });
                localStorage.setItem(CACHE_KEYS.VISITS, JSON.stringify(cacheObj)); 
            } catch(e){}
        }
        
        try {
            const rawP = localStorage.getItem(CACHE_KEYS.PRODUCTS);
            if (rawP) productsDb = JSON.parse(rawP);
        } catch(e){}

        if (!productsDb || Object.keys(productsDb).length === 0) {
            productsDb = { ...DEFAULT_SAMPLE_PRODUCTS };
            try { localStorage.setItem(CACHE_KEYS.PRODUCTS, JSON.stringify(productsDb)); } catch(e){}
        }

        if (!sales || sales.length === 0) {
            sales = [...DEFAULT_SAMPLE_SALES];
            try { localStorage.setItem(CACHE_KEYS.SALES, JSON.stringify(sales)); } catch(e){}
        }

        let linkedSales = [];
        sales.forEach(order => {
            const orderProducts = productsDb[order.id] || productsDb[order.orderId] || [];
            const financials = calculateOrderFinancials(order, orderProducts);
            linkedSales.push({ ...order, completedSum: financials.completedSum, pendingSum: financials.pendingSum });
        });

        firestoreRawData = { visits, opportunities: opps, sales: linkedSales, customers };
        
        populateFilterOptions();
        updateDashboard();
    } catch(e) {
        console.warn("Local cache read notice:", e);
    }
}

function getEyeHideIconSvg(size = 16) {
    return `<svg class="eye-icon eye-hide-icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path>
        <circle cx="12" cy="12" r="3.2"></circle>
        <line x1="4" y1="20" x2="20" y2="4"></line>
    </svg>`;
}

function getEyeShowIconSvg(size = 16) {
    return `<svg class="eye-icon eye-show-icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path>
        <circle cx="12" cy="12" r="3.2"></circle>
    </svg>`;
}

function initBlurToggle() {
    const toggleBlurBtn = document.getElementById('toggleBlurBtn');
    const yearlyTable = document.querySelector('.yearly-table');
    if (toggleBlurBtn && yearlyTable) {
        const updateIcon = (isBlurred) => {
            toggleBlurBtn.innerHTML = isBlurred ? getEyeHideIconSvg(16) : getEyeShowIconSvg(16);
            toggleBlurBtn.setAttribute('title', isBlurred ? 'إظهار الأرقام' : 'إخفاء الأرقام');
        };

        const isCurrentlyBlurred = localStorage.getItem('tableBlurred') === 'true';
        if (isCurrentlyBlurred) {
            yearlyTable.classList.add('is-blurred');
            toggleBlurBtn.classList.add('active');
            updateIcon(true);
        } else {
            updateIcon(false);
        }
        
        toggleBlurBtn.addEventListener('click', () => {
            const isBlurred = yearlyTable.classList.toggle('is-blurred');
            toggleBlurBtn.classList.toggle('active', isBlurred);
            updateIcon(isBlurred);
            try { localStorage.setItem('tableBlurred', isBlurred ? 'true' : 'false'); } catch(e) {}
        });
    }
}

function initTargetEditToggle() {
    const editBtn = document.getElementById('editTargetBtn');
    if (!editBtn) return;
    editBtn.addEventListener('click', () => {
        isEditingTargets = !isEditingTargets;
        editBtn.classList.toggle('active', isEditingTargets);
        if (!isEditingTargets) {
            const inputs = document.querySelectorAll('.target-input');
            if (inputs.length === 12) {
                saveStoredTargets(Array.from(inputs).map(inp => Math.max(0, parseFloat(inp.value) || 0)));
            }
        }
        updateDashboard();
    });
}

function watchThemeChanges() {
    const isInitialDark = document.body.classList.contains('dark-mode');
    updateChartsTheme(isInitialDark);
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.attributeName === 'class') {
                updateChartsTheme(document.body.classList.contains('dark-mode'));
                updateDashboard();
            }
        });
    });
    observer.observe(document.body, { attributes: true });
}

function updateChartsTheme(isDark) {
    if (typeof window.Chart === 'undefined') return;
    const Chart = window.Chart;
    Chart.defaults.color = isDark ? '#f8fafc' : '#334155';
    const gridColor = isDark ? '#334155' : '#e2e8f0';
    const borderColor = isDark ? '#1e293b' : '#ffffff';
    if (staffChart && staffChart.options.scales) {
        if (staffChart.options.scales.x) staffChart.options.scales.x.ticks.color = isDark ? '#f8fafc' : '#334155';
        if (staffChart.options.scales.y) {
            staffChart.options.scales.y.grid.color = gridColor;
            staffChart.options.scales.y.ticks.color = isDark ? '#f8fafc' : '#334155';
        }
        staffChart.update();
    }
    const ringCharts = [achievedChart, pendingChart, q1Chart, q2Chart, q3Chart, q4Chart];
    ringCharts.forEach(chart => {
        if (chart && chart.data && chart.data.datasets[0]) {
            chart.data.datasets[0].borderColor = borderColor;
            if (chart.options && chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels) {
                chart.options.plugins.legend.labels.color = isDark ? '#cbd5e1' : '#475569';
            }
            chart.update();
        }
    });
    if (monthlyTrendChart && monthlyTrendChart.options && monthlyTrendChart.options.scales) {
        const tGridColor = isDark ? 'rgba(51, 65, 85, 0.35)' : 'rgba(226, 232, 240, 0.7)';
        const tTextColor = isDark ? '#94a3b8' : '#64748b';
        if (monthlyTrendChart.options.scales.x) {
            monthlyTrendChart.options.scales.x.grid.color = tGridColor;
            monthlyTrendChart.options.scales.x.ticks.color = tTextColor;
        }
        if (monthlyTrendChart.options.scales.y) {
            monthlyTrendChart.options.scales.y.grid.color = tGridColor;
        }
        monthlyTrendChart.update();
    }
    if (gaugeChart) gaugeChart.update();
}

function listenToFirestoreData() {
    if (!db) return;

    let visitsData = firestoreRawData.visits || [];
    let oppsData = firestoreRawData.opportunities || [];
    let salesDb = firestoreRawData.sales || [];
    let customersData = firestoreRawData.customers || [];
    updateSyncStatus('loading');

    const handleSnapshotError = () => {
        updateSyncStatus('saved');
    };

    try {
        onSnapshot(doc(db, "settings", "monthlyTargets"), (docSnap) => {
            if (docSnap.exists() && docSnap.data().values && docSnap.data().values.length === 12) {
                monthlyTargetsArr = docSnap.data().values;
                try { localStorage.setItem(CACHE_KEYS.TARGETS, JSON.stringify(monthlyTargetsArr)); } catch(e){}
                updateDashboard();
                updateSyncStatus('saved');
            }
        }, () => handleSnapshotError("monthlyTargets"));
    } catch(e){}

    const checkAndUpdate = debounce(() => {
        let linkedSales = [];
        salesDb.forEach(order => {
            const orderProducts = productsDb[order.id] || productsDb[order.orderId] || [];
            const financials = calculateOrderFinancials(order, orderProducts);
            linkedSales.push({ ...order, completedSum: financials.completedSum, pendingSum: financials.pendingSum });
        });
        firestoreRawData = { visits: visitsData, opportunities: oppsData, sales: linkedSales, customers: customersData };
        populateFilterOptions();
        updateDashboard();
        updateSyncStatus('saved');
    }, 250);

    try {
        onSnapshot(collection(db, "visits"), snap => {
            visitsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            try { 
                let cacheObj = {};
                visitsData.forEach(v => { cacheObj[v.id] = v; });
                localStorage.setItem(CACHE_KEYS.VISITS, JSON.stringify(cacheObj)); 
            } catch(e){}
            checkAndUpdate();
        }, () => handleSnapshotError("visits"));

        onSnapshot(collection(db, "opportunities"), snap => {
            oppsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            try { 
                let cacheObj = {};
                oppsData.forEach(o => { cacheObj[o.id] = o; });
                localStorage.setItem(CACHE_KEYS.OPPORTUNITIES, JSON.stringify(cacheObj)); 
            } catch(e){}
            checkAndUpdate();
        }, () => handleSnapshotError("opportunities"));

        onSnapshot(collection(db, "sales"), snap => {
            salesDb = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            try { localStorage.setItem(CACHE_KEYS.SALES, JSON.stringify(salesDb)); } catch(e){}
            checkAndUpdate();
        }, () => handleSnapshotError("sales"));

        onSnapshot(collection(db, "customers"), snap => {
            customersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            try { localStorage.setItem(CACHE_KEYS.CUSTOMERS, JSON.stringify(customersData)); } catch(e){}
            checkAndUpdate();
        }, () => handleSnapshotError("customers"));

        onSnapshot(collection(db, "products"), snap => {
            productsDb = {};
            snap.docs.forEach(d => {
                const data = d.data();
                if (data.orderId) { 
                    if (!productsDb[data.orderId]) productsDb[data.orderId] = []; 
                    productsDb[data.orderId].push(data); 
                }
            });
            try { localStorage.setItem(CACHE_KEYS.PRODUCTS, JSON.stringify(productsDb)); } catch(e){}
            checkAndUpdate();
        }, () => handleSnapshotError("products"));
    } catch(e) {
        console.warn("Local storage fallback mode:", e);
    }
}

function populateFilterOptions() {
    const allData = [...(firestoreRawData.sales||[]), ...(firestoreRawData.opportunities||[]), ...(firestoreRawData.visits||[])];
    const regions = new Set(), supervisors = new Set(), salesmen = new Set(), years = new Set(["2026"]);

    allData.forEach(item => {
        if (item.region) regions.add(item.region.trim());
        if (item.supervisor) supervisors.add(item.supervisor.trim());
        const salesPerson = (item.salesman || item.owner || "").trim();
        if (salesPerson && salesPerson !== "المستخدم") salesmen.add(salesPerson);
        const isSale = Object.prototype.hasOwnProperty.call(item, 'comp') || Object.prototype.hasOwnProperty.call(item, 'completedSum');
        let itemDate = getItemDate(item, isSale);
        if (itemDate) {
            let y = parseYearFromDate(itemDate);
            if (y && y.length === 4) years.add(y);
        }
    });

    fillSelect(document.getElementById('filterRegion'), regions, "الكل");
    fillSelect(document.getElementById('filterSupervisor'), supervisors, "الكل");
    fillSelect(document.getElementById('filterSalesman'), salesmen, "الكل");
    const sortedYears = Array.from(years).filter(y => y && y.length === 4).sort((a, b) => b.localeCompare(a));
    fillSelect(document.getElementById('filterYear'), sortedYears, "2026");
    fillSelect(document.getElementById('filterMonth'), monthsNames, "الكل", true);
}

function fillSelect(selectElement, setOrArray, defaultVal, isMonth = false) {
    if (!selectElement) return;
    const currentValue = selectElement.value;
    selectElement.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.text = defaultVal;
    defaultOpt.value = defaultVal === "الكل" ? "all" : defaultVal;
    selectElement.appendChild(defaultOpt);

    setOrArray.forEach((val, index) => {
        if(!val) return;
        if(isMonth && val === defaultVal) return;
        if(val === defaultVal) return;
        const opt = document.createElement('option');
        opt.text = String(val).trim();
        opt.value = isMonth ? (index + 1).toString().padStart(2, '0') : String(val).trim();
        selectElement.appendChild(opt);
    });

    if (isMonth) {
        if (!isInitialMonthLoaded) {
            const currentMonthStr = (new Date().getMonth() + 1).toString().padStart(2, '0');
            if (selectElement.querySelector(`option[value="${currentMonthStr}"]`)) {
                selectElement.value = currentMonthStr;
            }
            isInitialMonthLoaded = true;
            return;
        }
    }

    try {
        if (currentValue && selectElement.querySelector(`option[value="${CSS.escape(currentValue)}"]`)) {
            selectElement.value = currentValue;
        }
    } catch(e) {
        if (currentValue && Array.from(selectElement.options).some(o=>o.value===currentValue)) {
            selectElement.value = currentValue;
        }
    }
}

function getQuarterColors(m1, m2, m3, isDark) {
    const defaultEmpty = isDark ? '#334155' : '#e2e8f0';
    if (m1 === 0 && m2 === 0 && m3 === 0) return [defaultEmpty, defaultEmpty, defaultEmpty];
    let vals = [{ idx: 0, v: m1 }, { idx: 1, v: m2 }, { idx: 2, v: m3 }];
    vals.sort((a, b) => b.v - a.v);
    vals[0].color = '#10b981'; vals[1].color = '#f59e0b'; vals[2].color = '#ef4444';
    let result = [];
    result[vals[0].idx] = vals[0].color; result[vals[1].idx] = vals[1].color; result[vals[2].idx] = vals[2].color;
    return result;
}

function updateQuarterChart(chart, pctElementId, m1, m2, m3, targetQuarterly) {
    if(!chart || !chart.data) return;
    const isDark = document.body.classList.contains('dark-mode');
    const emptyColor = isDark ? '#1e293b' : '#f1f5f9';
    let colors = getQuarterColors(m1, m2, m3, isDark);
    let achieved = m1 + m2 + m3;
    let remaining = Math.max(0, targetQuarterly - achieved);
    
    chart.data.datasets[0].data = [m1, m2, m3, remaining];
    chart.data.datasets[0].backgroundColor = [...colors, emptyColor];
    chart.data.datasets[0].borderColor = isDark ? '#1e293b' : '#ffffff';
    chart.update();
    
    const pctEl = document.getElementById(pctElementId);
    if(pctEl) pctEl.innerText = (targetQuarterly > 0 ? Math.round((achieved / targetQuarterly) * 100) : 0) + '%';
}

function initCharts() {
    if (typeof window.Chart === 'undefined') {
        setTimeout(initCharts, 200);
        return;
    }
    const Chart = window.Chart;
    const isDark = document.body.classList.contains('dark-mode');
    const emptyBg = isDark ? '#1e293b' : '#f1f5f9';

    const achievedEl = document.getElementById('achievedChart');
    if (achievedEl && !achievedChart) {
        achievedChart = new Chart(achievedEl, {
            type: 'doughnut',
            data: { datasets: [{ data: [0, 100], backgroundColor: ['#10b981', emptyBg], borderWidth: 0, borderRadius: 10 }] },
            options: { cutout: '82%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.dataIndex === 0 ? 'المكتمل: ' + (ctx.parsed || 0).toLocaleString('en-US') + ' ريال' : 'المتبقي: ' + (ctx.parsed || 0).toLocaleString('en-US') + ' ريال' } } } }
        });
    }

    const pendingEl = document.getElementById('pendingChart');
    if (pendingEl && !pendingChart) {
        pendingChart = new Chart(pendingEl, {
            type: 'doughnut',
            data: { datasets: [{ data: [0, 100], backgroundColor: ['#f59e0b', emptyBg], borderWidth: 0, borderRadius: 10 }] },
            options: { cutout: '82%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.dataIndex === 0 ? 'المعلق: ' + (ctx.parsed || 0).toLocaleString('en-US') + ' ريال' : 'المتبقي: ' + (ctx.parsed || 0).toLocaleString('en-US') + ' ريال' } } } }
        });
    }

    const gaugeNeedlePlugin = {
        id: 'gaugeNeedle',
        afterDatasetDraw(chart, args, options) {
            const { ctx, chartArea } = chart;
            if (!chartArea) return;
            ctx.save();
            let percent = Math.min(options.percent || 0, 100);
            const angle = Math.PI + (Math.PI * (percent / 100));
            const meta = chart.getDatasetMeta(0);
            if (!meta || !meta.data || !meta.data.length) { ctx.restore(); return; }
            
            const cx = meta.data[0].x, cy = meta.data[0].y, needleLength = chartArea.width / 2.3;
            const dMode = document.body.classList.contains('dark-mode');
            
            ctx.translate(cx, cy); ctx.rotate(angle);
            ctx.beginPath(); ctx.moveTo(0, -2); ctx.lineTo(needleLength, 0); ctx.lineTo(0, 2); ctx.fillStyle = dMode ? '#34d399' : '#0a3a22'; ctx.fill();
            ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#10b981'; ctx.fill();
            ctx.lineWidth = 1.2; ctx.strokeStyle = dMode ? '#34d399' : '#0a3a22'; ctx.stroke();
            ctx.restore();
        }
    };

    const gaugeEl = document.getElementById('gaugeChart');
    if (gaugeEl && !gaugeChart) {
        gaugeChart = new Chart(gaugeEl.getContext('2d'), { 
            type: 'doughnut', plugins: [gaugeNeedlePlugin], 
            data: { datasets: [{ data: [100], backgroundColor: function(context) { 
                const chart = context.chart; const {ctx, chartArea} = chart; 
                if (!chartArea) return '#10b981';
                const gradient = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0); 
                gradient.addColorStop(0, '#ef4444'); gradient.addColorStop(0.5, '#fbbf24'); gradient.addColorStop(1, '#10b981'); 
                return gradient; 
            }, borderWidth: 0 }] }, 
            options: { rotation: 270, circumference: 180, cutout: '80%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false }, gaugeNeedle: { percent: 0 } } } 
        });
    }

    const quarterOptions = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ['الشهر الأول', 'الشهر الثاني', 'الشهر الثالث', 'متبقي من الهدف'][ctx.dataIndex] + ': ' + (ctx.parsed||0).toLocaleString() + ' ريال' } } } };
    const qInitialData = { datasets: [{ data: [0, 0, 0, 100], backgroundColor: [emptyBg, emptyBg, emptyBg, emptyBg], borderWidth: 2, borderColor: isDark ? '#1e293b' : '#ffffff' }] };
    
    if (document.getElementById('q1Chart') && !q1Chart) q1Chart = new Chart(document.getElementById('q1Chart'), { type: 'pie', data: JSON.parse(JSON.stringify(qInitialData)), options: quarterOptions });
    if (document.getElementById('q2Chart') && !q2Chart) q2Chart = new Chart(document.getElementById('q2Chart'), { type: 'pie', data: JSON.parse(JSON.stringify(qInitialData)), options: quarterOptions });
    if (document.getElementById('q3Chart') && !q3Chart) q3Chart = new Chart(document.getElementById('q3Chart'), { type: 'pie', data: JSON.parse(JSON.stringify(qInitialData)), options: quarterOptions });
    if (document.getElementById('q4Chart') && !q4Chart) q4Chart = new Chart(document.getElementById('q4Chart'), { type: 'pie', data: JSON.parse(JSON.stringify(qInitialData)), options: quarterOptions });
    const trendEl = document.getElementById('monthlyTrendChart');
    if (trendEl && !monthlyTrendChart) {
        const gridColor = isDark ? 'rgba(51, 65, 85, 0.35)' : 'rgba(226, 232, 240, 0.7)';
        const axisTextColor = isDark ? '#94a3b8' : '#64748b';

        monthlyTrendChart = new Chart(trendEl.getContext('2d'), {
            type: 'line',
            data: {
                labels: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
                datasets: [
                    {
                        label: 'مكتمل',
                        data: Array(12).fill(0),
                        rawValues: Array(12).fill(0),
                        borderColor: '#00B050',
                        backgroundColor: '#00B050',
                        pointBackgroundColor: '#00B050',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 1.2,
                        pointStyle: 'rectRot',
                        pointRadius: 4.5,
                        pointHoverRadius: 6.5,
                        borderWidth: 2.2,
                        tension: 0,
                        yAxisID: 'y'
                    },
                    {
                        label: 'الفرص',
                        data: Array(12).fill(0),
                        rawValues: Array(12).fill(0),
                        borderColor: '#FFC000',
                        backgroundColor: '#FFC000',
                        pointBackgroundColor: '#FFC000',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 1.2,
                        pointStyle: 'circle',
                        pointRadius: 4.5,
                        pointHoverRadius: 6.5,
                        borderWidth: 2.2,
                        tension: 0,
                        yAxisID: 'y1'
                    },
                    {
                        label: 'الزيارات',
                        data: Array(12).fill(0),
                        rawValues: Array(12).fill(0),
                        borderColor: '#C00000',
                        backgroundColor: '#C00000',
                        pointBackgroundColor: '#C00000',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 1.2,
                        pointStyle: 'triangle',
                        pointRadius: 4.5,
                        pointHoverRadius: 6.5,
                        borderWidth: 2.2,
                        tension: 0,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.94)',
                        titleFont: { family: 'Cairo', size: 11, weight: 'bold' },
                        bodyFont: { family: 'Cairo', size: 10.5, weight: '600' },
                        padding: 8,
                        cornerRadius: 6,
                        callbacks: {
                            title: (items) => {
                                const idx = items[0]?.dataIndex;
                                const mName = monthsNames[idx] || `شهر ${idx + 1}`;
                                return `شهر ${idx + 1} (${mName})`;
                            },
                            label: (ctx) => {
                                const rawVal = ctx.dataset.rawValues ? ctx.dataset.rawValues[ctx.dataIndex] : 0;
                                if (ctx.datasetIndex === 0) {
                                    return ` مكتمل: ${Number(rawVal || 0).toLocaleString('en-US')} ريال`;
                                } else if (ctx.datasetIndex === 1) {
                                    return ` الفرص: ${Number(rawVal || 0).toLocaleString('en-US')} فرصة`;
                                } else {
                                    return ` الزيارات: ${Number(rawVal || 0).toLocaleString('en-US')} زيارة`;
                                }
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: gridColor,
                            drawTicks: true
                        },
                        ticks: {
                            font: { family: 'Cairo', size: 9.5, weight: '700' },
                            color: axisTextColor
                        }
                    },
                    y: {
                        position: 'left',
                        min: 0,
                        max: 10,
                        grid: {
                            color: gridColor,
                            drawBorder: true
                        },
                        ticks: {
                            stepSize: 1,
                            font: { family: 'Cairo', size: 9, weight: '700' },
                            color: '#00B050',
                            callback: function(value) {
                                const labels = ['0', '5 الف', '8 الف', '12 الف', '15 الف', '20 الف', '50 الف', '100 الف', '150 الف', '250 الف', '500 الف'];
                                if (labels[value] !== undefined) return labels[value];
                                if (value > 10) {
                                    const extraVal = 500000 + (value - 10) * 250000;
                                    return (extraVal / 1000) + ' الف';
                                }
                                return '';
                            }
                        }
                    },
                    y1: {
                        position: 'right',
                        min: 0,
                        max: 10,
                        grid: {
                            display: false
                        },
                        ticks: {
                            stepSize: 1,
                            font: { family: 'Cairo', size: 9, weight: '700' },
                            color: isDark ? '#cbd5e1' : '#475569',
                            callback: function(value) {
                                const labels = ['0', '50', '80', '120', '150', '200', '500', '1000', '1500', '2500', '5000'];
                                if (labels[value] !== undefined) return labels[value];
                                if (value > 10) {
                                    const extraVal = 5000 + (value - 10) * 2500;
                                    return String(extraVal);
                                }
                                return '';
                            }
                        }
                    }
                }
            }
        });
    }

    if (document.getElementById('staffChart') && !staffChart) {
        staffChart = new Chart(document.getElementById('staffChart').getContext('2d'), {
            type: 'bar',
            data: { labels: [], datasets: [ { label: 'مكتمل', data: [], backgroundColor: '#10b981', barPercentage: 0.8, categoryPercentage: 0.6 }, { label: 'معلق', data: [], backgroundColor: '#f59e0b', barPercentage: 0.8, categoryPercentage: 0.6 } ] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { callbacks: { label: ctx => (ctx.dataset.label ? ctx.dataset.label + ': ' : '') + Number(ctx.parsed.y).toLocaleString('en-US') + ' ريال' } } }, scales: { x: { grid: { display: false }, ticks: { font: { family: 'Cairo', size: 11 }, maxRotation: 45, minRotation: 45 } }, y: { grid: { color: isDark ? '#334155' : '#e2e8f0' } } } }
        });
    }
}

function updateChartsLogic(salesTotal, pendingTotal, filteredSales = [], activeTarget = 180000, monthlySalesArr = [], unfilteredMonthlySalesArr = [], unfilteredMonthlyVisitsArr = [], unfilteredMonthlyOppsArr = []) {
    const isDark = document.body.classList.contains('dark-mode');
    const emptyBg = isDark ? '#1e293b' : '#f1f5f9';
    const safeTarget = activeTarget > 0 ? activeTarget : 1;
    const salesPercent = Math.round((salesTotal / safeTarget) * 100);
    const pendingPercent = Math.round((pendingTotal / safeTarget) * 100);
    const gaugePercentRaw = (salesTotal / safeTarget) * 100;

    if(document.getElementById('achievedPct')) document.getElementById('achievedPct').innerText = `${salesPercent}%`;
    if(document.getElementById('pendingPct')) document.getElementById('pendingPct').innerText = `${pendingPercent}%`;
    if(document.getElementById('gaugePct')) document.getElementById('gaugePct').innerText = `${Math.round(gaugePercentRaw)}%`;
    if(document.getElementById('achievedSubLabel')) document.getElementById('achievedSubLabel').innerText = `${salesTotal.toLocaleString('en-US')} / ${activeTarget.toLocaleString('en-US')}`;
    if(document.getElementById('pendingSubLabel')) document.getElementById('pendingSubLabel').innerText = `${pendingTotal.toLocaleString('en-US')} / ${activeTarget.toLocaleString('en-US')}`;

    if (achievedChart && achievedChart.data) {
        achievedChart.data.datasets[0].data = salesTotal >= safeTarget ? [salesTotal, 0] : [salesTotal, Math.max(0, safeTarget - salesTotal)];
        achievedChart.data.datasets[0].backgroundColor = ['#00B050', emptyBg];
        achievedChart.update();
    }

    if (pendingChart && pendingChart.data) {
        pendingChart.data.datasets[0].data = pendingTotal >= safeTarget ? [pendingTotal, 0] : [pendingTotal, Math.max(0, safeTarget - pendingTotal)];
        pendingChart.data.datasets[0].backgroundColor = ['#f59e0b', emptyBg];
        pendingChart.update();
    }

    if (gaugeChart && gaugeChart.options) {
        gaugeChart.options.plugins.gaugeNeedle.percent = Math.min(gaugePercentRaw, 100);
        gaugeChart.update();
    }

    if (monthlyTrendChart && monthlyTrendChart.data) {
        const totalSalesVolume = unfilteredMonthlySalesArr.reduce((a, b) => a + b, 0);
        const totalVisitsVolume = unfilteredMonthlyVisitsArr.reduce((a, b) => a + b, 0);
        const totalOppsVolume = (unfilteredMonthlyOppsArr || []).reduce((a, b) => a + b, 0);

        const compEl = document.getElementById('trendCompletedTotal');
        if (compEl) compEl.innerText = `${totalSalesVolume.toLocaleString('en-US')} ريال`;
        const oppEl = document.getElementById('trendOppsTotal');
        if (oppEl) oppEl.innerText = `${totalOppsVolume.toLocaleString('en-US')} فرصة`;
        const visEl = document.getElementById('trendVisitsTotal');
        if (visEl) visEl.innerText = `${totalVisitsVolume.toLocaleString('en-US')} زيارة`;

        const mappedSales = unfilteredMonthlySalesArr.map(v => mapValueToTierPosition(v, COMPLETED_TIERS));
        const mappedOpps = (unfilteredMonthlyOppsArr || Array(12).fill(0)).map(v => mapValueToTierPosition(v, COUNT_TIERS));
        const mappedVisits = unfilteredMonthlyVisitsArr.map(v => mapValueToTierPosition(v, COUNT_TIERS));

        monthlyTrendChart.data.datasets[0].data = mappedSales;
        monthlyTrendChart.data.datasets[0].rawValues = [...unfilteredMonthlySalesArr];

        monthlyTrendChart.data.datasets[1].data = mappedOpps;
        monthlyTrendChart.data.datasets[1].rawValues = [...(unfilteredMonthlyOppsArr || Array(12).fill(0))];

        monthlyTrendChart.data.datasets[2].data = mappedVisits;
        monthlyTrendChart.data.datasets[2].rawValues = [...unfilteredMonthlyVisitsArr];

        const maxMapped = Math.max(10, ...mappedSales, ...mappedOpps, ...mappedVisits);
        const targetMax = Math.max(10, Math.ceil(maxMapped));
        if (monthlyTrendChart.options.scales.y) {
            monthlyTrendChart.options.scales.y.max = targetMax;
        }
        if (monthlyTrendChart.options.scales.y1) {
            monthlyTrendChart.options.scales.y1.max = targetMax;
        }

        monthlyTrendChart.update();
    }

    if (staffChart && staffChart.data) {
        const staffAggregation = {};
        filteredSales.forEach(sale => {
            const name = (sale.salesman || sale.owner || "").trim();
            if (!name) return;
            if (!staffAggregation[name]) staffAggregation[name] = { completed: 0, pending: 0 };
            staffAggregation[name].completed += (sale.completedSum || 0);
            staffAggregation[name].pending += (sale.pendingSum || 0);
        });

        const realStaffNames = Object.keys(staffAggregation).sort((a, b) => (staffAggregation[b].completed + staffAggregation[b].pending) - (staffAggregation[a].completed + staffAggregation[a].pending));

        if (realStaffNames.length > 0) {
            staffChart.data.labels = realStaffNames;
            staffChart.data.datasets[0].data = realStaffNames.map(name => staffAggregation[name].completed);
            staffChart.data.datasets[1].data = realStaffNames.map(name => staffAggregation[name].pending);
        } else {
            staffChart.data.labels = ['لا بيانات متوفرة'];
            staffChart.data.datasets[0].data = [0];
            staffChart.data.datasets[1].data = [0];
        }
        staffChart.update();
    }
}

function updateDashboard() {
    const data = firestoreRawData;
    const sYear = document.getElementById('filterYear')?.value || "2026";
    const sMonth = document.getElementById('filterMonth')?.value || "all";
    const sRegion = document.getElementById('filterRegion')?.value || "all";
    const sSuper = document.getElementById('filterSupervisor')?.value || "all";
    const sSales = document.getElementById('filterSalesman')?.value || "all";

    const filterCallback = (item, isSale = false) => {
        const iDate = getItemDate(item, isSale);
        let itemYear = parseYearFromDate(iDate) || "", itemMonth = parseMonthFromDate(iDate) || "";
        if (sYear !== "all" && itemYear !== sYear) return false;
        if (sMonth !== "all" && itemMonth !== sMonth) return false;
        if (sRegion !== "all" && (item.region||"").trim() !== sRegion) return false;
        if (sSuper !== "all" && (item.supervisor||"").trim() !== sSuper) return false;
        if (sSales !== "all" && (item.salesman || item.owner || "").trim() !== sSales) return false;
        return true;
    };

    const filteredSales = (data.sales||[]).filter(item => filterCallback(item, true));
    const filteredOpps = (data.opportunities||[]).filter(item => filterCallback(item, false));
    const filteredVisits = (data.visits||[]).filter(item => filterCallback(item, false));
    
    const tableSales = (data.sales||[]).filter(item => {
        const iDate = getItemDate(item, true);
        let itemYear = parseYearFromDate(iDate) || "";
        if (sYear !== "all" && itemYear !== sYear) return false;
        if (sRegion !== "all" && (item.region||"").trim() !== sRegion) return false;
        if (sSuper !== "all" && (item.supervisor||"").trim() !== sSuper) return false;
        if (sSales !== "all" && (item.salesman || item.owner || "").trim() !== sSales) return false;
        return true;
    });

    const tableOpps = (data.opportunities||[]).filter(item => {
        const iDate = getItemDate(item, false);
        let itemYear = parseYearFromDate(iDate) || "";
        if (sYear !== "all" && itemYear !== sYear) return false;
        if (sRegion !== "all" && (item.region||"").trim() !== sRegion) return false;
        if (sSuper !== "all" && (item.supervisor||"").trim() !== sSuper) return false;
        if (sSales !== "all" && (item.salesman || item.owner || "").trim() !== sSales) return false;
        return true;
    });

    const tableVisits = (data.visits||[]).filter(item => {
        const iDate = getItemDate(item, false);
        let itemYear = parseYearFromDate(iDate) || "";
        if (sYear !== "all" && itemYear !== sYear) return false;
        if (sRegion !== "all" && (item.region||"").trim() !== sRegion) return false;
        if (sSuper !== "all" && (item.supervisor||"").trim() !== sSuper) return false;
        if (sSales !== "all" && (item.salesman || item.owner || "").trim() !== sSales) return false;
        return true;
    });

    let totalSales = 0, totalPending = 0;
    let monthlySalesArr = Array(12).fill(0), unfilteredMonthlySalesArr = Array(12).fill(0), unfilteredMonthlyVisitsArr = Array(12).fill(0), unfilteredMonthlyOppsArr = Array(12).fill(0);

    filteredSales.forEach(sale => {
        totalSales += (sale.completedSum || 0);
        totalPending += (sale.pendingSum || 0);
        const sDate = getItemDate(sale, true);
        let month = parseInt(parseMonthFromDate(sDate));
        if (month >= 1 && month <= 12) monthlySalesArr[month - 1] += (sale.completedSum || 0);
    });

    tableSales.forEach(sale => {
        const sDate = getItemDate(sale, true);
        let month = parseInt(parseMonthFromDate(sDate));
        if (month >= 1 && month <= 12) unfilteredMonthlySalesArr[month - 1] += (sale.completedSum || 0);
    });

    tableVisits.forEach(v => {
        const vDate = getItemDate(v, false);
        let month = parseInt(parseMonthFromDate(vDate));
        if (month >= 1 && month <= 12) unfilteredMonthlyVisitsArr[month - 1] += 1;
    });

    tableOpps.forEach(o => {
        const oDate = getItemDate(o, false);
        let month = parseInt(parseMonthFromDate(oDate));
        if (month >= 1 && month <= 12) unfilteredMonthlyOppsArr[month - 1] += 1;
    });

    if(oppCountEl) oppCountEl.innerText = filteredOpps.length.toLocaleString('en-US');
    if(visitCountEl) visitCountEl.innerText = filteredVisits.length.toLocaleString('en-US');
    if(salesValueEl) salesValueEl.innerText = totalSales.toLocaleString('en-US');
    if(pendingValueEl) pendingValueEl.innerText = totalPending.toLocaleString('en-US');

    updateYearlyTable(tableSales, tableOpps, tableVisits, sMonth);
    const targets = getStoredTargets();
    let activeTarget = (sMonth !== "all") ? (targets[parseInt(sMonth) - 1] || 0) : targets.reduce((a, b) => a + b, 0);

    if (document.getElementById('targetCardLabel')) document.getElementById('targetCardLabel').innerText = (sMonth !== "all") ? `هدف شهر ${monthsNames[parseInt(sMonth) - 1]}` : 'الهدف السنوي';
    if (document.getElementById('yearlyTargetCardVal')) document.getElementById('yearlyTargetCardVal').innerText = activeTarget.toLocaleString('en-US');

    updateChartsLogic(totalSales, totalPending, filteredSales, activeTarget, monthlySalesArr, unfilteredMonthlySalesArr, unfilteredMonthlyVisitsArr, unfilteredMonthlyOppsArr);
    
    const q1Target = (targets[0] + targets[1] + targets[2]) || 45000;
    const q2Target = (targets[3] + targets[4] + targets[5]) || 45000;
    const q3Target = (targets[6] + targets[7] + targets[8]) || 45000;
    const q4Target = (targets[9] + targets[10] + targets[11]) || 45000;
    const avgQuarterTarget = Math.round((q1Target + q2Target + q3Target + q4Target) / 4);
    
    if (document.getElementById('quarterTitleHeader')) document.getElementById('quarterTitleHeader').innerText = `تحليل مبيعات الأرباع السنوية (متوسط هدف الربع: ${Math.round(avgQuarterTarget/1000)}k)`;

    updateQuarterChart(q1Chart, 'q1Pct', unfilteredMonthlySalesArr[0], unfilteredMonthlySalesArr[1], unfilteredMonthlySalesArr[2], q1Target);
    updateQuarterChart(q2Chart, 'q2Pct', unfilteredMonthlySalesArr[3], unfilteredMonthlySalesArr[4], unfilteredMonthlySalesArr[5], q2Target);
    updateQuarterChart(q3Chart, 'q3Pct', unfilteredMonthlySalesArr[6], unfilteredMonthlySalesArr[7], unfilteredMonthlySalesArr[8], q3Target);
    updateQuarterChart(q4Chart, 'q4Pct', unfilteredMonthlySalesArr[9], unfilteredMonthlySalesArr[10], unfilteredMonthlySalesArr[11], q4Target);
}

function updateYearlyTable(sales, opps, visits, selectedMonth = "all") {
    if (!tbody) return;
    tbody.innerHTML = '';
    const targets = getStoredTargets();
    let totalTarget = 0, totalCompleted = 0, totalPending = 0, totalVisits = 0, totalOpps = 0;

    monthsNames.forEach((monthName, index) => {
        const monthCode = (index + 1).toString().padStart(2, '0');
        const mSales = sales.filter(s => parseMonthFromDate(getItemDate(s, true)) === monthCode);
        const mOpps = opps.filter(o => parseMonthFromDate(getItemDate(o, false)) === monthCode);
        const mVisits = visits.filter(v => parseMonthFromDate(getItemDate(v, false)) === monthCode);

        let mCompleted = 0, mPending = 0;
        mSales.forEach(s => {
            mCompleted += (s.completedSum || 0);
            mPending += (s.pendingSum || 0);
        });

        const currentTarget = targets[index] || 0;
        totalTarget += currentTarget;
        totalCompleted += mCompleted;
        totalPending += mPending;
        totalVisits += mVisits.length;
        totalOpps += mOpps.length;

        const targetDisplay = isEditingTargets
            ? `<input type="number" class="target-input" min="0" data-index="${index}" value="${currentTarget}">`
            : currentTarget.toLocaleString('en-US');

        const isRowSelected = (selectedMonth !== "all" && selectedMonth === monthCode);
        const rowClass = isRowSelected ? 'selected-month-row' : '';

        tbody.insertAdjacentHTML('beforeend', `
            <tr class="${rowClass}">
                <td style="font-weight: 800;">${monthName}</td>
                <td>${targetDisplay}</td>
                <td style="color: var(--light-green); font-weight: 800;">${mCompleted > 0 ? mCompleted.toLocaleString('en-US') : '-'}</td>
                <td class="thick-border" style="color: #f59e0b; font-weight: 800;">${mPending > 0 ? mPending.toLocaleString('en-US') : '-'}</td>
                <td>${mVisits.length > 0 ? mVisits.length : '-'}</td>
                <td>${mOpps.length > 0 ? mOpps.length : '-'}</td>
            </tr>
        `);
    });

    if (isEditingTargets) {
        document.querySelectorAll('.target-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const idx = parseInt(e.target.dataset.index);
                targets[idx] = Math.max(0, parseFloat(e.target.value) || 0);
                saveStoredTargets(targets);
                if (document.getElementById('totTarget')) document.getElementById('totTarget').innerText = targets.reduce((a, b) => a + b, 0).toLocaleString('en-US');
            });
        });
    }

    if (document.getElementById('totTarget')) document.getElementById('totTarget').innerText = totalTarget.toLocaleString('en-US');
    if (document.getElementById('totCompleted')) document.getElementById('totCompleted').innerText = totalCompleted > 0 ? totalCompleted.toLocaleString('en-US') : '0';
    if (document.getElementById('totPending')) document.getElementById('totPending').innerText = totalPending > 0 ? totalPending.toLocaleString('en-US') : '0';
    if (document.getElementById('totVisits')) document.getElementById('totVisits').innerText = totalVisits > 0 ? totalVisits.toLocaleString('en-US') : '0';
    if (document.getElementById('totOpps')) document.getElementById('totOpps').innerText = totalOpps > 0 ? totalOpps.toLocaleString('en-US') : '0';
}

function initResetFilters() {
    const resetBtn = document.getElementById('resetFiltersBtn');
    if (!resetBtn) return;
    resetBtn.addEventListener('click', () => {
        ['filterRegion', 'filterSupervisor', 'filterSalesman'].forEach(id => {
            if (document.getElementById(id)) document.getElementById(id).value = 'all';
        });
        const currentMonth = (new Date().getMonth() + 1).toString().padStart(2, '0');
        if (document.getElementById('filterMonth')) {
            document.getElementById('filterMonth').value = currentMonth;
        }
        if (document.getElementById('filterYear')) document.getElementById('filterYear').value = '2026';
        updateDashboard();
    });
}

function initCsvExport() {
    const exportBtn = document.getElementById('exportCsvBtn');
    if (!exportBtn) return;
    exportBtn.addEventListener('click', () => {
        const targets = getStoredTargets();
        let csvContent = "\uFEFFالشهر,الهدف,المكتمل,المعلق,الزيارات,الفرص\n";
        monthsNames.forEach((month, idx) => {
            const monthCode = (idx + 1).toString().padStart(2, '0');
            const mSales = (firestoreRawData.sales||[]).filter(s => parseMonthFromDate(s.saleDate || s.createdAt) === monthCode);
            const mOpps = (firestoreRawData.opportunities||[]).filter(o => parseMonthFromDate(o.oppDate || o.date || o.visitDate) === monthCode);
            const mVisits = (firestoreRawData.visits||[]).filter(v => parseMonthFromDate(v.visitDate || v.date || v.oppDate) === monthCode);
            let completed = 0, pending = 0;
            mSales.forEach(s => { completed += (s.completedSum||0); pending += (s.pendingSum||0); });
            csvContent += `"${month}",${targets[idx] || 0},${completed},${pending},${mVisits.length},${mOpps.length}\n`;
        });
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `تقرير_المبيعات_السنوي_2026.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

function initDashboard() {
    oppCountEl = document.getElementById('oppCount');
    visitCountEl = document.getElementById('visitCount');
    salesValueEl = document.getElementById('salesValue');
    pendingValueEl = document.getElementById('pendingValue');
    tbody = document.getElementById('monthsBody');

    const monthEl = document.getElementById('filterMonth');
    if (monthEl) {
        const curMonth = (new Date().getMonth() + 1).toString().padStart(2, '0');
        if (monthEl.querySelector(`option[value="${curMonth}"]`)) {
            monthEl.value = curMonth;
        }
    }

    watchThemeChanges();
    initBlurToggle();
    initTargetEditToggle();
    initCharts();
    initResetFilters();
    initCsvExport();
    
    loadDataFromLocalCache();
    listenToFirestoreData();

    document.querySelectorAll('.filters-grid select').forEach(select => select.addEventListener('change', updateDashboard));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDashboard);
} else {
    initDashboard();
}
