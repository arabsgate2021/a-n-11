// ==========================================
// order_details.js - تفاصيل الطلب بنظام التخزين المؤقت وتوفير كوتا فايربيز
// 1. استراتيجية Client-side Caching: قراءة فورية من localStorage قبل أي اتصال بالشبكة
// 2. تقليل كوتا القراءة: فحص asgate_sales_db لجلب بيانات الطلب محلياً أولاً
// 3. تأخير (Debounce) إرسال التعديلات لـ Firebase مع استخدام { merge: true }
// 4. استخدام writeBatch في الحذف والإضافة والاستيراد
// 5. حماية التركيز (Focus Protection) وعدم مقاطعة المستخدم أثناء الكتابة
// ==========================================
import Swal from 'sweetalert2';
import * as XLSX from 'xlsx';
window.Swal = Swal;
window.XLSX = XLSX;

import { 
    db,
    collection, 
    query, 
    where, 
    onSnapshot, 
    doc, 
    setDoc, 
    getDoc, 
    deleteDoc, 
    writeBatch 
} from './firebase-config.js';

import { normalizeCr, isCustomerMatchedByCr, createActivityLogEntry, renderActivityLogsHTML } from './src/crm_logic.js';

const urlParams = new URLSearchParams(window.location.search);
let currentOrderId = urlParams.get('id') || urlParams.get('orderId') || urlParams.get('code') || localStorage.getItem('current_order_id') || "";
let queryCr = urlParams.get('cr') || "";

if (!currentOrderId) {
    try {
        const sales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        if (sales.length > 0) currentOrderId = String(sales[0].id);
    } catch(e){}
}
if (!currentOrderId) currentOrderId = "26010001";
localStorage.setItem('current_order_id', currentOrderId);

const statusOptions = ["مكتمل", "معلق", "جديد", "مرتجع", "فقدان"];
const LOGS_KEY = 'asgate_order_logs_' + currentOrderId;
const GLOBAL_NOTES_KEY = 'asgate_global_notes_' + currentOrderId;

let activeStatusFilters = [...statusOptions];
let dateSortDir = null;
const saveFieldTimeouts = {};

const defaultSampleProducts = {
    "26010001": [
        { docId: "prod_26_01", orderId: "26010001", type: "جوال", name: "باقة أعمال متميزة 100", qty: 2, sub: 1500.0, serial: "899660260101", mobile: "0501234567", user: "1023456789", status: "مكتمل", date: "14-01-2026", time: "11:25", rowNote: "تم التفعيل وتسليم الشريحة" },
        { docId: "prod_26_02", orderId: "26010001", type: "بيانات", name: "شريحة بيانات 5G مفتوحة", qty: 1, sub: 2500.0, serial: "899660260102", mobile: "0507654321", user: "1023456789", status: "مكتمل", date: "14-01-2026", time: "12:10", rowNote: "جاهز للاستخدام" },
        { docId: "prod_26_03", orderId: "26010001", type: "جوال", name: "باقة اتصال مرن 50", qty: 2, sub: 600.0, serial: "899660260103", mobile: "0509876543", user: "1023456789", status: "معلق", date: "15-01-2026", time: "15:45", rowNote: "بانتظار توثيق نفاذ" }
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
    ]
};

function escapeHTML(str) {
    if (!str && str !== 0) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatNumberWithOneDecimal(num) {
    return Number(num || 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatDateDisplay(dateString) {
    if (!dateString || dateString === '---') return '---';
    let cleanDate = String(dateString).trim().replace(/\//g, '-');
    if (cleanDate.includes(' ')) cleanDate = cleanDate.split(' ')[0];
    return cleanDate;
}

function formatTimeDisplay(timeString, dateString = null, updatedAt = null) {
    if (timeString && String(timeString).trim() !== '' && timeString !== '---') {
        let t = String(timeString).trim();
        const parts = t.split(':');
        if (parts.length >= 2) {
            const hh = String(parseInt(parts[0], 10) || 0).padStart(2, '0');
            const mm = String(parseInt(parts[1], 10) || 0).padStart(2, '0');
            return `${hh}:${mm}`;
        }
        return t;
    }
    if (dateString && String(dateString).includes(' ')) {
        const parts = String(dateString).trim().split(' ');
        if (parts[1]) {
            const tParts = parts[1].split(':');
            if (tParts.length >= 2) {
                const hh = String(parseInt(tParts[0], 10) || 0).padStart(2, '0');
                const mm = String(parseInt(tParts[1], 10) || 0).padStart(2, '0');
                return `${hh}:${mm}`;
            }
            return parts[1];
        }
    }
    if (updatedAt) {
        try {
            const d = new Date(updatedAt);
            if (!isNaN(d.getTime())) {
                return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
            }
        } catch(e) {}
    }
    return '';
}

function parseProductDate(dateString, timeString = '') {
    if (!dateString || dateString === '---') return 0;
    let cleanDate = String(dateString).trim().replace(/\//g, '-');
    let timePart = String(timeString || '').trim();
    if (cleanDate.includes(' ')) {
        const parts = cleanDate.split(' ');
        cleanDate = parts[0];
        if (!timePart && parts[1]) timePart = parts[1];
    }
    let hours = 0;
    let minutes = 0;
    if (timePart) {
        const tParts = timePart.split(':');
        if (tParts.length >= 2) {
            hours = parseInt(tParts[0], 10) || 0;
            minutes = parseInt(tParts[1], 10) || 0;
        }
    }
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
        let p0 = parseInt(parts[0], 10);
        let p1 = parseInt(parts[1], 10);
        let p2 = parseInt(parts[2], 10);
        if (parts[0].length === 4) {
            return new Date(p0, p1 - 1, p2, hours, minutes).getTime();
        } else if (parts[2].length === 4 || p2 > 1000) {
            return new Date(p2, p1 - 1, p0, hours, minutes).getTime();
        } else {
            return new Date(2000 + p2, p1 - 1, p0, hours, minutes).getTime();
        }
    }
    const parsed = new Date(dateString).getTime();
    return isNaN(parsed) ? 0 : parsed;
}

function toggleDateSort(event) {
    if (event) event.stopPropagation();
    if (dateSortDir === 'desc') {
        dateSortDir = 'asc';
    } else {
        dateSortDir = 'desc';
    }
    renderProducts();
}

function setDateSort(dir) {
    dateSortDir = dir;
    renderProducts();
}

function isRowVisible(row) {
    if (!row) return false;
    if (row.style.display === 'none') return false;
    if (row.classList.contains('hidden')) return false;
    if (row.offsetParent === null && window.getComputedStyle(row).display === 'none') return false;
    return true;
}

function updateMasterCheckboxState() {
    const masterCb = document.getElementById('checkAllBox');
    if (!masterCb) return;
    const visibleRows = Array.from(document.querySelectorAll('#productsBody tr')).filter(isRowVisible);
    if (visibleRows.length === 0) {
        masterCb.checked = false;
        masterCb.indeterminate = false;
        return;
    }
    const visibleChecks = visibleRows.map(r => r.querySelector('.row-checkbox')).filter(Boolean);
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

function toggleAll(source) {
    const isChecked = !!(source && source.checked);
    const rows = document.querySelectorAll('#productsBody tr');
    rows.forEach(row => {
        const chk = row.querySelector('.row-checkbox');
        if (!chk) return;
        if (isRowVisible(row)) {
            chk.checked = isChecked;
        } else {
            chk.checked = false;
        }
    });
    updateMasterCheckboxState();
    calculateTotals();
}

function toggleLogExpansion() {
    const section = document.getElementById('activityLogSection');
    const btn = document.getElementById('toggleExpandBtn');
    if (!section || !btn) return;
    if (section.classList.contains('expanded')) {
        section.classList.remove('expanded');
        document.body.classList.remove('log-expanded');
        btn.innerHTML = '<i class="fas fa-expand-alt"></i>';
    } else {
        section.classList.add('expanded');
        document.body.classList.add('log-expanded');
        btn.innerHTML = '<i class="fas fa-compress-alt"></i>';
    }
}

function getTodayFormatted() {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
}

function getTimeFormatted() {
    const d = new Date();
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function generateInlineHeaderHTML() {
    const timeFormatted = getTimeFormatted();
    return `<span class="log-header-info">
                <span class="log-badge-user"><i class="fas fa-user"></i> المستخدم</span>
                <span class="log-sep">|</span>
                <span class="log-timestamp"><i class="fas fa-calendar-alt"></i> ${getTodayFormatted()} <i class="fas fa-clock" style="margin-right:3px;"></i> ${timeFormatted}</span>
            </span>`;
}

function addToActivityLog(fieldName, oldVal, newVal, productIdentifier) {
    const entry = createActivityLogEntry({
        page: 'order_details',
        fieldName,
        oldVal,
        newVal,
        identifier: productIdentifier || 'بدون سريال',
        user: 'المستخدم'
    });
    if (!entry) return;
    let logs = [];
    try {
        const parsed = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');
        logs = Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
    } catch (e) {
        logs = [];
    }
    logs.unshift(entry);
    const updatedLogs = logs.slice(0, 100);
    localStorage.setItem(LOGS_KEY, JSON.stringify(updatedLogs));
    renderActivityLog();

    if (db && currentOrderId) {
        setDoc(doc(db, "sales", String(currentOrderId)), {
            activityLogs: updatedLogs,
            updatedAt: Date.now()
        }, { merge: true }).catch((e) => console.warn("إشعار حفظ سجل نشاط الطلب سحابياً:", e));
    }
}

function triggerActionLog(actionType) {
    if (actionType === 'تصدير Excel') {
        exportToExcel();
    } else if (actionType === 'طباعة') {
        window.print();
    } else if (actionType === 'حذف المحدد') {
        deleteSelected();
    }
}

function renderActivityLog() {
    const list = document.getElementById('activityList');
    if(!list) return;
    let logs = [];
    try {
        const parsed = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');
        logs = Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
    } catch (e) {
        logs = [];
    }
    list.innerHTML = renderActivityLogsHTML(logs, 'order_details');
}

async function loadOrderDetails() {
    localStorage.setItem('current_order_id', currentOrderId);
    let orderData = null;

    try {
        const savedSales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        orderData = savedSales.find(s => String(s.id) === String(currentOrderId));
    } catch (e) {
        console.warn("خطأ قراءة كاش المبيعات المحلي:", e);
    }

    if (db && currentOrderId) {
        try {
            const salesDoc = await getDoc(doc(db, "sales", String(currentOrderId)));
            if (salesDoc.exists()) {
                const cloudOrder = salesDoc.data();
                cloudOrder.id = salesDoc.id;
                orderData = { ...(orderData || {}), ...cloudOrder };
                if (Array.isArray(cloudOrder.globalNotes) && cloudOrder.globalNotes.length > 0) {
                    localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(cloudOrder.globalNotes));
                }
                if (Array.isArray(cloudOrder.activityLogs) && cloudOrder.activityLogs.length > 0) {
                    localStorage.setItem(LOGS_KEY, JSON.stringify(cloudOrder.activityLogs));
                }
                try {
                    let savedSales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
                    const idx = savedSales.findIndex(s => String(s.id) === String(currentOrderId));
                    if (idx > -1) savedSales[idx] = orderData;
                    else savedSales.unshift(orderData);
                    localStorage.setItem('asgate_sales_db', JSON.stringify(savedSales));
                } catch(e){}
            }

            onSnapshot(doc(db, "sales", String(currentOrderId)), (snap) => {
                if (!snap.exists()) return;
                const liveOrder = snap.data();
                if (Array.isArray(liveOrder.globalNotes)) {
                    localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(liveOrder.globalNotes));
                    const btn = document.getElementById('globalNotesBtn');
                    if (btn) btn.setAttribute('data-full-notes', JSON.stringify(liveOrder.globalNotes));
                }
                if (Array.isArray(liveOrder.activityLogs) && liveOrder.activityLogs.length > 0) {
                    localStorage.setItem(LOGS_KEY, JSON.stringify(liveOrder.activityLogs));
                    renderActivityLog();
                }
            }, (err) => console.warn("ملاحظة الاستماع السحابي لبيانات الطلب:", err));
        } catch (e) {
            console.warn("إشعار جلب بيانات الطلب سحابياً:", e);
        }
    }

    // CR-based cross-match with customers directory
    let associatedCustomer = null;
    try {
        const customers = JSON.parse(localStorage.getItem('crm_customers') || localStorage.getItem('asgate_customers_db') || '[]');
        const targetCr = queryCr || (orderData ? (orderData.cr || orderData.commercialRecord) : "");
        if (targetCr) {
            associatedCustomer = customers.find(c => isCustomerMatchedByCr(c, targetCr));
        }
    } catch(e){}

    if (!orderData) {
        orderData = {
            id: currentOrderId,
            type: "توريد وتجهيز خطوط أعمال فايبر وسنترال",
            comp: associatedCustomer ? associatedCustomer.comp : "شركة الأفق للحلول الرقمية",
            cr: associatedCustomer ? (associatedCustomer.cr || associatedCustomer.cr1) : (queryCr || "1010345678"),
            status: "مكتمل",
            date: getTodayFormatted(),
            owner: "المستخدم"
        };
    } else {
        if (!orderData.type && !orderData.name) {
            orderData.type = "طلب مبيعات #" + (orderData.id || currentOrderId);
        }
        if (!orderData.comp && !orderData.company && !orderData.customer) {
            orderData.comp = associatedCustomer ? associatedCustomer.comp : "شركة الأفق للحلول الرقمية";
        }
        if (!orderData.cr && !orderData.commercialRecord) {
            orderData.cr = associatedCustomer ? (associatedCustomer.cr || associatedCustomer.cr1) : (queryCr || "1010345678");
        }
        if (!orderData.status) {
            orderData.status = "مكتمل";
        }
    }

    if (document.getElementById('orderId')) document.getElementById('orderId').innerText = '#' + (orderData.id || currentOrderId);
    if (document.getElementById('orderType')) document.getElementById('orderType').innerText = orderData.type || orderData.name || '-';
    if (document.getElementById('orderComp')) document.getElementById('orderComp').innerText = orderData.comp || orderData.company || orderData.customer || (associatedCustomer ? associatedCustomer.comp : '-');
    if (document.getElementById('orderCr')) document.getElementById('orderCr').innerText = orderData.cr || orderData.commercialRecord || (associatedCustomer ? (associatedCustomer.cr || associatedCustomer.cr1) : '-');
    if (document.getElementById('orderStatus')) document.getElementById('orderStatus').innerText = orderData.status || '-';

    let dbProducts = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    if (!dbProducts[currentOrderId]) {
        if (Object.prototype.hasOwnProperty.call(defaultSampleProducts, currentOrderId)) {
            dbProducts[currentOrderId] = defaultSampleProducts[currentOrderId];
        } else {
            dbProducts[currentOrderId] = [];
        }
        localStorage.setItem('asgate_products_db', JSON.stringify(dbProducts));
    }

    renderProducts();
    calculateTotals();
    updateStatsBox();
    renderActivityLog();
    setupScrollSync();

    listenToProducts();
}

function setupScrollSync() {
    const bodyScroll = document.getElementById('tableBodyScroll');
    const footerContainer = document.getElementById('tableFooterContainer');
    if (bodyScroll && footerContainer) {
        let isSyncing = false;
        bodyScroll.addEventListener('scroll', () => {
            if (!isSyncing) {
                isSyncing = true;
                footerContainer.scrollLeft = bodyScroll.scrollLeft;
                requestAnimationFrame(() => { isSyncing = false; });
            }
        });
        footerContainer.addEventListener('scroll', () => {
            if (!isSyncing) {
                isSyncing = true;
                bodyScroll.scrollLeft = footerContainer.scrollLeft;
                requestAnimationFrame(() => { isSyncing = false; });
            }
        });
    }
}

function listenToProducts() {
    if (!db || !currentOrderId) return;

    try {
        const productsRef = collection(db, "products");
        const orderProductsQuery = query(productsRef, where("orderId", "==", String(currentOrderId)));

        onSnapshot(orderProductsQuery, (snapshot) => {
            const isUserEditing = document.activeElement && document.activeElement.closest('#productsBody');
            const hasPendingSaves = Object.keys(saveFieldTimeouts).length > 0;

            const dbProducts = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
            if (!dbProducts[currentOrderId]) dbProducts[currentOrderId] = [];

            if (!snapshot.empty) {
                const cloudProducts = [];
                snapshot.forEach((docSnap) => {
                    const data = docSnap.data();
                    cloudProducts.push({ docId: docSnap.id, ...data });
                });

                if (!isUserEditing && !hasPendingSaves) {
                    dbProducts[currentOrderId] = cloudProducts;
                    localStorage.setItem('asgate_products_db', JSON.stringify(dbProducts));
                    renderProducts();
                } else {
                    cloudProducts.forEach(cp => {
                        const existingIdx = dbProducts[currentOrderId].findIndex(p => p.docId === cp.docId);
                        if (existingIdx > -1) {
                            dbProducts[currentOrderId][existingIdx] = { ...cp, ...dbProducts[currentOrderId][existingIdx] };
                        } else {
                            dbProducts[currentOrderId].push(cp);
                        }
                    });
                    localStorage.setItem('asgate_products_db', JSON.stringify(dbProducts));
                }
            }
        }, (err) => {
            console.warn("إشعار الاستماع السحابي لمنتجات الطلب:", err);
        });
    } catch(err) {
        console.warn("وضع العمل المحلي للمنتجات:", err);
    }
}

function validateNumberInput(el, isFloat = false) {
    let originalText = el.innerText;
    let cleanedText = originalText;
    if (isFloat) cleanedText = originalText.replace(/[^0-9.]/g, '').replace(/(\..*?)\..*/g, '$1');
    else cleanedText = originalText.replace(/[^0-9]/g, '');
    if (originalText !== cleanedText) {
        el.innerText = cleanedText;
        let range = document.createRange();
        let sel = window.getSelection();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

function compareSerials(sA, sB) {
    if (sA === sB) return 0;
    if (!sA) return 1;
    if (!sB) return -1;
    if (/^\d+$/.test(sA) && /^\d+$/.test(sB)) {
        if (sA.length !== sB.length) {
            return sA.length - sB.length;
        }
        return sA.localeCompare(sB);
    }
    return sA.localeCompare(sB, undefined, { numeric: true, sensitivity: 'base' });
}

function getSequentialSerial(baseSerialStr, index) {
    if (!baseSerialStr) return '';
    const str = String(baseSerialStr).trim();
    if (index === 0) return str;

    if (/^\d+$/.test(str)) {
        try {
            const baseBig = BigInt(str);
            const nextBig = baseBig + BigInt(index);
            return nextBig.toString().padStart(str.length, '0');
        } catch (e) {
            return str;
        }
    }

    const match = str.match(/^(.*?)(\d+)$/);
    if (match) {
        const prefix = match[1];
        const numPart = match[2];
        try {
            const baseBig = BigInt(numPart);
            const nextBig = baseBig + BigInt(index);
            const padded = nextBig.toString().padStart(numPart.length, '0');
            return prefix + padded;
        } catch (e) {
            return str;
        }
    }

    return str;
}

function renderProducts(filtered = null) {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    let baseItems = dbData[currentOrderId] || [];
    baseItems.forEach(p => { if (!statusOptions.includes(p.status)) p.status = "جديد"; });
    let items = (filtered || baseItems).map((p, i) => ({...p, originalIndex: i}));
    
    if (dateSortDir === 'asc') {
        items.sort((a, b) => {
            const tA = parseProductDate(a.date, a.time);
            const tB = parseProductDate(b.date, b.time);
            if (tA !== tB) return tA - tB;
            let sA = String(a.serial || "");
            let sB = String(b.serial || "");
            return compareSerials(sA, sB);
        });
    } else if (dateSortDir === 'desc') {
        items.sort((a, b) => {
            const tA = parseProductDate(a.date, a.time);
            const tB = parseProductDate(b.date, b.time);
            if (tA !== tB) return tB - tA;
            let sA = String(a.serial || "");
            let sB = String(b.serial || "");
            return compareSerials(sA, sB);
        });
    } else {
        items.sort((a, b) => {
            let sA = String(a.serial || "");
            let sB = String(b.serial || "");
            if (!sA && !sB) return 0;
            if (!sA) return 1;
            if (!sB) return -1;
            return compareSerials(sA, sB);
        });
    }
    
    updateTableHeaders(items.length > 0 ? items[0].type : "جوال");
    const tbody = document.getElementById('productsBody');
    if(!tbody) return;
    tbody.innerHTML = '';
    
    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding:25px; color:#64748b; font-weight:700; height:60px;">لا توجد منتجات مسجلة لهذا الطلب<br><small style="color:#94a3b8;">اضغط + إضافة منتج جديد للبدء</small></td></tr>`;
        calculateTotals();
        updateStatsBox();
        updateMasterCheckboxState();
        updateOrderTotalHeader();
        return;
    }

    items.forEach((p) => {
        const subVal = parseFloat(p.sub) || 0;
        let sClass = "";
        if (p.status === "مكتمل") sClass = "status-mektamel";
        else if (p.status === "معلق") sClass = "status-moallaq";
        else if (p.status === "جديد") sClass = "status-jadid";
        else if (p.status === "مرتجع") sClass = "status-mortaja";
        else if (p.status === "فقدان") sClass = "status-faqd";

        const isLocked = ["مكتمل", "معلق"].includes(p.status);
        const isLoss = (p.status === "فقدان");
        const pIden = escapeHTML(p.serial || p.sai || 'بدون سريال');
        const rNote = escapeHTML(p.rowNote || '');
        const displayDate = formatDateDisplay(p.date || '');
        const displayTime = formatTimeDisplay(p.time, p.date, p.updatedAt);

        let dynamic = (p.type === "جوال" || p.type === "بيانات") ? `
            <td style="width: 155px;" data-field="serial" title="${escapeHTML(p.serial||'')}" contenteditable="${!isLocked}" data-old="${escapeHTML(p.serial||'')}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" oninput="window.validateNumberInput(this, false)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'serial',this.innerText); }">${escapeHTML(p.serial||'')}</td>
            <td style="width: 145px;" data-field="mobile" class="col-contact col-service" contenteditable="${!isLocked}" data-old="${escapeHTML(p.mobile||'')}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" oninput="window.validateNumberInput(this, false)" onblur="if(this.getAttribute('data-old')!=this.innerText){ const rowSerial = (this.closest('tr')?.querySelector('[data-field=serial]')?.innerText || '${pIden}').trim() || 'بدون سريال'; window.addToActivityLog('رقم الخدمة', this.getAttribute('data-old'), this.innerText, rowSerial); window.updateField(${p.originalIndex},'mobile',this.innerText); }">${escapeHTML(p.mobile||'')}</td>
            <td style="width: 145px;" data-field="user" contenteditable="${!isLocked}" data-old="${escapeHTML(p.user||'')}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" oninput="window.validateNumberInput(this, false)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'user',this.innerText); }">${escapeHTML(p.user||'')}</td>` : `
            <td style="width: 155px;" data-field="sai" contenteditable="${!isLocked}" data-old="${escapeHTML(p.sai||'')}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'sai',this.innerText); }">${escapeHTML(p.sai||'')}</td>
            <td style="width: 145px;" data-field="coords" contenteditable="${!isLocked}" data-old="${escapeHTML(p.coords||'')}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'coords',this.innerText); }">${escapeHTML(p.coords||'')}</td>
            <td style="width: 145px;" data-field="city" contenteditable="${!isLocked}" data-old="${escapeHTML(p.city||'')}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'city',this.innerText); }">${escapeHTML(p.city||'')}</td>`;

        tbody.innerHTML += `<tr class="${isLocked ? 'row-locked' : ''} ${isLoss ? 'row-loss' : ''}" data-index="${p.originalIndex}">
            <td style="width: 35px;" class="not-locked" data-field="checkbox"><input type="checkbox" class="row-checkbox" data-index="${p.originalIndex}" data-locked="${isLocked}" data-docid="${escapeHTML(p.docId || '')}" onchange="window.calculateTotals(); window.updateMasterCheckboxState();"></td>
            <td style="width: 100px;" data-field="type">${escapeHTML(p.type)}</td>
            <td style="width: 180px;" data-field="name" contenteditable="${!isLocked}" data-old="${escapeHTML(p.name)}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" onblur="if(this.getAttribute('data-old')!=this.innerText){ const rowSerial = (this.closest('tr')?.querySelector('[data-field=serial],[data-field=sai]')?.innerText || '${pIden}').trim() || 'بدون سريال'; window.addToActivityLog('تفاصيل المنتج', this.getAttribute('data-old'), this.innerText, rowSerial); window.updateField(${p.originalIndex},'name',this.innerText); }">${escapeHTML(p.name)}</td>
            <td style="width: 50px;" data-field="qty" contenteditable="${!isLocked}" data-old="${escapeHTML(String(p.qty))}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" oninput="window.validateNumberInput(this, false)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'qty',this.innerText); }">${escapeHTML(String(p.qty))}</td>
            <td style="width: 80px;" data-field="sub" contenteditable="${!isLocked}" data-old="${subVal.toFixed(1)}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" oninput="window.validateNumberInput(this, true)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'sub',this.innerText); }">${formatNumberWithOneDecimal(subVal)}</td>
            <td style="width: 85px; color:var(--header-green);font-weight:800;" data-field="total">${formatNumberWithOneDecimal(p.qty * subVal)}</td>
            ${dynamic}
            <td style="width: 110px;" data-field="status" class="not-locked"><select class="status-select ${sClass}" data-old="${escapeHTML(p.status)}" onfocus="this.setAttribute('data-old', this.value); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" onchange="window.changeStatus(${p.originalIndex},this.value)">
                ${statusOptions.map(s=>`<option value="${escapeHTML(s)}" ${p.status===s?'selected':''}>${escapeHTML(s)}</option>`).join('')}</select></td>
            <td style="width: 90px;" data-field="date">
                <div class="status-datetime-cell">
                    <span class="status-date-text">${escapeHTML(displayDate)}</span>
                    ${displayTime ? `<span class="status-time-text">${escapeHTML(displayTime)}</span>` : ''}
                </div>
            </td>
            <td style="min-width: 120px;" data-field="rowNote" contenteditable="${!isLocked}" data-old="${rNote}" onfocus="this.setAttribute('data-old', this.innerText); window.trackProductCell && window.trackProductCell(this);" onclick="window.trackProductCell && window.trackProductCell(this);" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'rowNote',this.innerText); }">${rNote}</td>
            </tr>`;
    });

    applyFilters();
}

function updateOrderTotalHeader() {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    let total = 0;
    dbData.forEach(p => {
        total += (parseInt(p.qty) || 0) * (parseFloat(p.sub) || 0);
    });
    const el = document.getElementById('orderTotalSum');
    if (el) el.innerText = formatNumberWithOneDecimal(total) + " ر.س";
}

function updateTableHeaders(type) {
    const header = document.getElementById('dynamicHeader');
    if(!header) return;
    let dynamic = (type === "جوال" || type === "بيانات") 
        ? `<th style="width: 155px;">رقم السريال</th><th class="col-contact col-service" style="width: 145px;">رقم الخدمة</th><th style="width: 145px;">هوية المستخدم</th>` 
        : `<th style="width: 155px;">رقم الكبينة</th><th style="width: 145px;">الإحداثيات</th><th style="width: 145px;">المدينة</th>`;

    header.innerHTML = `
        <th style="width: 35px;">
            <input type="checkbox" id="checkAllBox" onclick="window.toggleAll(this)">
        </th>
        <th style="width: 100px;">نوع المنتج</th>
        <th style="width: 180px;">تفاصيل المنتج</th>
        <th style="width: 50px;">العدد</th>
        <th style="width: 80px;">الاشتراك</th>
        <th style="width: 85px;">الإجمالي</th>
        ${dynamic}
        <th style="width: 110px;">
            <div class="custom-filter-wrapper">
                <div class="filter-title" onclick="window.toggleCustomFilter(event, 'statusFilterMenu')">
                    الحالة <i class="fas fa-caret-down filter-arrow"></i>
                    <span class="filter-dot" id="statusFilterDot"></span>
                </div>
                <div id="statusFilterMenu" class="multi-select-menu" onclick="event.stopPropagation()">
                    <div style="display: flex; gap: 4px; padding: 2px 4px 6px 4px; border-bottom: 1px solid #f1f5f9; margin-bottom: 4px;">
                        <button type="button" onclick="window.selectAllFilter('statusFilterMenu')" style="flex:1; background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; border-radius:4px; padding:3px; font-size:9px; font-weight:700; cursor:pointer; font-family:Cairo;">الكل</button>
                        <button type="button" onclick="window.clearAllFilter('statusFilterMenu')" style="flex:1; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:4px; padding:3px; font-size:9px; font-weight:700; cursor:pointer; font-family:Cairo;">تفريغ</button>
                    </div>
                    <div id="statusFilterItemsContainer" style="display:flex; flex-direction:column; gap:2px;"></div>
                </div>
            </div>
        </th>
        <th style="width: 90px;" class="sort-date-th" onclick="window.toggleDateSort(event)" title="ترتيب حسب تاريخ الحالة (اضغط للتبديل)">
            <div style="display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 100%; width: 100%;">
                <span>تاريخ الحالة</span>
                <span class="sort-arrows-container">
                    <i class="fas fa-caret-up sort-arrow-btn ${dateSortDir === 'asc' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDateSort('asc');" title="الأقدم ثم الأحدث"></i>
                    <i class="fas fa-caret-down sort-arrow-btn ${dateSortDir === 'desc' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDateSort('desc');" title="الأحدث فالأقدم"></i>
                </span>
            </div>
        </th>
        <th style="min-width: 120px;">سجل المتابعة</th>
    `;
    populateStatusFilterMenu();
}

function populateStatusFilterMenu() {
    const container = document.getElementById('statusFilterItemsContainer');
    if (!container) return;
    container.innerHTML = statusOptions.map(opt => `
        <label class="multi-select-item">
            <input type="checkbox" value="${escapeHTML(opt)}" ${activeStatusFilters.includes(opt) ? 'checked' : ''} onchange="window.updateStatusFilters()">
            <span class="custom-cb"><i class="fas fa-check"></i></span>
            <span>${escapeHTML(opt)}</span>
        </label>
    `).join('');
    updateStatusFilterDot();
}

function toggleCustomFilter(event, menuId) {
    if (event) event.stopPropagation();
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
    if (isAlreadyOpen) {
        targetMenu.classList.remove('show');
        if (wrapper) wrapper.classList.remove('active');
    } else {
        targetMenu.classList.add('show');
        if (wrapper) wrapper.classList.add('active');
    }
}

function selectAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    updateStatusFilters();
}

function clearAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateStatusFilters();
}

function updateStatusFilters() {
    const checkedBoxes = Array.from(document.querySelectorAll('#statusFilterMenu input[type="checkbox"]:checked'));
    activeStatusFilters = checkedBoxes.map(cb => cb.value);
    updateStatusFilterDot();
    applyFilters();
}

function updateStatusFilterDot() {
    const dot = document.getElementById('statusFilterDot');
    if (dot) {
        dot.style.display = (activeStatusFilters.length < statusOptions.length) ? 'inline-block' : 'none';
    }
}

function updateStatsBox() {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    let totalOkAmount = 0, totalWaitAmount = 0, monthOkAmount = 0, monthWaitAmount = 0;
    dbData.forEach(p => {
        const productTotal = (parseInt(p.qty) || 0) * (parseFloat(p.sub) || 0);
        if (p.status === "مكتمل") totalOkAmount += productTotal;
        if (p.status === "معلق") totalWaitAmount += productTotal;
        const cleanDate = String(p.date || '').replace(/\//g, '-');
        const parts = cleanDate.split('-');
        if (parts.length === 3) {
            let pMonth, pYear;
            if (parts[0].length === 4) {
                pYear = parseInt(parts[0]);
                pMonth = parseInt(parts[1]);
            } else {
                pMonth = parseInt(parts[1]);
                pYear = parseInt(parts[2]);
            }
            if (pMonth === currentMonth && pYear === currentYear) {
                if (p.status === "مكتمل") monthOkAmount += productTotal;
                if (p.status === "معلق") monthWaitAmount += productTotal;
            }
        }
    });
    if(document.getElementById('stat_total_ok')) document.getElementById('stat_total_ok').innerText = formatNumberWithOneDecimal(totalOkAmount);
    if(document.getElementById('stat_total_wait')) document.getElementById('stat_total_wait').innerText = formatNumberWithOneDecimal(totalWaitAmount);
    if(document.getElementById('stat_month_ok')) document.getElementById('stat_month_ok').innerText = formatNumberWithOneDecimal(monthOkAmount);
    if(document.getElementById('stat_month_wait')) document.getElementById('stat_month_wait').innerText = formatNumberWithOneDecimal(monthWaitAmount);
    updateOrderTotalHeader();
}

async function updateField(idx, f, v) {
    let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    if (!dbData[currentOrderId]) dbData[currentOrderId] = [];
    let item = dbData[currentOrderId][idx];
    if(!item) return;

    item[f] = v.trim(); 
    item.updatedAt = Date.now(); 
    localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
    calculateTotals();
    updateStatsBox();

    const saveKey = `${currentOrderId}_${item.docId || idx}`;
    if (saveFieldTimeouts[saveKey]) clearTimeout(saveFieldTimeouts[saveKey]);

    saveFieldTimeouts[saveKey] = setTimeout(async () => {
        delete saveFieldTimeouts[saveKey];
        if (item.docId && db) {
            try {
                await setDoc(doc(db, "products", item.docId), item, { merge: true });
            } catch(e) {
                console.warn("خطأ التعديل السحابي للمنتج:", e);
            }
        }
    }, 600);
}

async function changeStatus(idx, s) {
    let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    if (!dbData[currentOrderId]) dbData[currentOrderId] = [];
    let item = dbData[currentOrderId][idx];
    if(!item) return;
    const oldS = item.status;
    const pIden = item.serial || item.sai || 'بدون سريال';
    addToActivityLog('الحالة', oldS, s, pIden);
    item.status = s; 
    item.updatedAt = Date.now(); 
    item.date = getTodayFormatted();
    item.time = getTimeFormatted();
    localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
    renderProducts();

    if (item.docId && db) {
        try {
            await setDoc(doc(db, "products", item.docId), item, { merge: true });
        } catch(e) {
            console.warn("خطأ تعديل الحالة سحابياً:", e);
        }
    }
}

async function deleteSelected() {
    const checkboxes = Array.from(document.querySelectorAll('#productsBody .row-checkbox:checked')).filter(chk => {
        const row = chk.closest('tr');
        return isRowVisible(row);
    });
    if (checkboxes.length === 0) {
        if (typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'info', text: 'يرجى تحديد منتج واحد على الأقل من الصفوف الظاهرة', confirmButtonColor: '#3b82f6' });
        } else {
            alert('يرجى تحديد منتج واحد');
        }
        return;
    }
    let confirmed = false;
    if (typeof Swal !== 'undefined') {
        const result = await Swal.fire({
            title: 'تأكيد الحذف؟',
            text: `سيتم حذف ${checkboxes.length} منتج من الصفوف الظاهرة`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#94a3b8',
            confirmButtonText: 'حذف',
            cancelButtonText: 'إلغاء'
        });
        confirmed = result.isConfirmed;
    } else {
        confirmed = confirm(`حذف ${checkboxes.length} منتج؟`);
    }
    if (!confirmed) return;

    let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    let list = dbData[currentOrderId] || [];
    const indicesToDelete = checkboxes.map(cb => parseInt(cb.dataset.index)).sort((a,b)=>b-a);
    
    const batch = db ? writeBatch(db) : null;
    let batchCount = 0;

    for (let idx of indicesToDelete) {
        const item = list[idx];
        if (item && item.docId && batch) {
            batch.delete(doc(db, "products", item.docId));
            batchCount++;
        }
        list.splice(idx, 1);
    }

    if (batch && batchCount > 0) {
        try {
            await batch.commit();
        } catch(e) {
            console.warn("إشعار دفعة الحذف السحابية:", e);
        }
    }

    dbData[currentOrderId] = list;
    localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
    renderProducts();
    addToActivityLog('زر إجراء', '', `حذف ${indicesToDelete.length} منتج`, '');
}

function calculateTotals() {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    const checkboxes = document.querySelectorAll('#productsBody .row-checkbox:checked');
    let totalQty = 0, totalSub = 0, totalSum = 0, count = 0;
    
    if (checkboxes.length > 0) {
        checkboxes.forEach(cb => {
            if (!isRowVisible(cb.closest('tr'))) return;
            const idx = parseInt(cb.dataset.index);
            const item = dbData[idx];
            if (!item) return;
            const qty = parseInt(item.qty) || 0;
            const sub = parseFloat(item.sub) || 0;
            totalQty += qty;
            totalSub += sub;
            totalSum += qty * sub;
            count++;
        });
    } else {
        const visibleRows = Array.from(document.querySelectorAll('#productsBody tr')).filter(isRowVisible);
        visibleRows.forEach(row => {
            const cb = row.querySelector('.row-checkbox');
            if (!cb) return;
            const idx = parseInt(cb.dataset.index);
            const item = dbData[idx];
            if (!item) return;
            const qty = parseInt(item.qty) || 0;
            const sub = parseFloat(item.sub) || 0;
            totalQty += qty;
            totalSub += sub;
            totalSum += qty * sub;
            count++;
        });
    }

    if (document.getElementById('f_selection')) document.getElementById('f_selection').innerText = checkboxes.length;
    if (document.getElementById('f_count')) document.getElementById('f_count').innerText = count;
    if (document.getElementById('f_qty')) document.getElementById('f_qty').innerText = totalQty;
    if (document.getElementById('f_sub')) document.getElementById('f_sub').innerText = formatNumberWithOneDecimal(totalSub);
    if (document.getElementById('f_total')) document.getElementById('f_total').innerText = formatNumberWithOneDecimal(totalSum);
    updateStatsBox();
    syncOrderSumsToSalesDb();
}

function syncOrderSumsToSalesDb() {
    if (!currentOrderId) return;
    try {
        const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
        let completed = 0, pending = 0;
        dbData.forEach(p => {
            const lineTotal = (parseFloat(p.qty) || 0) * (parseFloat(String(p.sub).replace(/[^\d.]/g, '')) || 0);
            if (p.status === "مكتمل") completed += lineTotal;
            if (p.status === "معلق") pending += lineTotal;
        });
        let sales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        const idx = sales.findIndex(s => String(s.id) === String(currentOrderId));
        if (idx > -1) {
            sales[idx].completedSum = completed;
            sales[idx].pendingSum = pending;
            localStorage.setItem('asgate_sales_db', JSON.stringify(sales));
            if (db) {
                setDoc(doc(db, "sales", currentOrderId), { completedSum: completed, pendingSum: pending }, { merge: true }).catch(() => {});
            }
        }
    } catch(e) {}
}

function applyFilters() {
    const query = (document.getElementById('liveSearch') ? document.getElementById('liveSearch').value.toLowerCase().trim() : '');
    const rows = document.querySelectorAll('#productsBody tr');
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        const matchSearch = !query || text.includes(query);
        let matchStatus = true;
        const statusSelect = row.querySelector('.status-select');
        if (statusSelect) {
            const status = statusSelect.value;
            if (activeStatusFilters.length === 0) matchStatus = false;
            else if (activeStatusFilters.length < statusOptions.length) {
                matchStatus = activeStatusFilters.includes(status);
            }
        }
        row.style.display = (matchSearch && matchStatus) ? '' : 'none';
    });
    calculateTotals();
    updateMasterCheckboxState();
}

function openModal() {
    const modal = document.getElementById('productModal');
    if (modal) modal.style.display = 'flex';
}
function closeModal() {
    const modal = document.getElementById('productModal');
    if (modal) modal.style.display = 'none';
    ['p_name','p_sub','p_qty','p_serial'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    const qtyEl=document.getElementById('p_qty'); if(qtyEl) qtyEl.value='1';
    const autoSerialEl = document.getElementById('auto_serial'); if(autoSerialEl) autoSerialEl.checked = false;
}

function handleTypeChange() {}

async function saveProduct() {
    const typeEl = document.getElementById('p_type');
    const nameEl = document.getElementById('p_name');
    const subEl = document.getElementById('p_sub');
    const qtyEl = document.getElementById('p_qty');
    const serialEl = document.getElementById('p_serial');
    const autoSerialEl = document.getElementById('auto_serial');

    const type = typeEl ? typeEl.value : 'جوال';
    const name = nameEl ? nameEl.value.trim() : '';
    const sub = subEl ? parseFloat(subEl.value) || 0 : 0;
    const qty = qtyEl ? parseInt(qtyEl.value, 10) || 1 : 1;
    let serial = serialEl ? serialEl.value.trim() : '';

    if (!name) {
        if (typeof Swal !== 'undefined') Swal.fire({ icon:'warning', text:'يرجى إدخال تفاصيل المنتج' });
        else alert('يرجى إدخال تفاصيل المنتج');
        return;
    }

    let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    if (!dbData[currentOrderId]) dbData[currentOrderId] = [];

    const isAuto = autoSerialEl ? autoSerialEl.checked : false;
    const batch = db ? writeBatch(db) : null;
    let batchCount = 0;

    if (isAuto) {
        for (let i = 0; i < qty; i++) {
            const currentSerial = getSequentialSerial(serial, i);
            const docId = 'prod_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5) + '_' + i;
            const newProduct = {
                docId: docId,
                orderId: currentOrderId,
                type: type,
                name: name,
                qty: 1,
                sub: sub,
                serial: currentSerial,
                mobile: '',
                user: '',
                status: 'جديد',
                date: getTodayFormatted(),
                time: getTimeFormatted(),
                rowNote: ''
            };
            dbData[currentOrderId].push(newProduct);
            if (batch) {
                batch.set(doc(db, "products", docId), newProduct);
                batchCount++;
            }
            addToActivityLog('إضافة منتج جديد', '', name, currentSerial || name);
        }
    } else {
        const docId = 'prod_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const newProduct = {
            docId: docId,
            orderId: currentOrderId,
            type: type,
            name: name,
            qty: qty,
            sub: sub,
            serial: serial,
            mobile: '',
            user: '',
            status: 'جديد',
            date: getTodayFormatted(),
            time: getTimeFormatted(),
            rowNote: ''
        };
        dbData[currentOrderId].push(newProduct);
        if (batch) {
            batch.set(doc(db, "products", docId), newProduct);
            batchCount++;
        }
        addToActivityLog('إضافة منتج جديد', '', name, serial || name);
    }

    if (batch && batchCount > 0) {
        try {
            await batch.commit();
        } catch(e) {
            console.warn("إشعار حفظ المنتجات سحابياً:", e);
        }
    }

    localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
    closeModal();
    renderProducts();
}

function exportToExcel() {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    if (dbData.length === 0) {
        alert('لا توجد بيانات للتصدير');
        return;
    }
    const exportData = dbData.map(p=>({
        "نوع المنتج": p.type,
        "تفاصيل المنتج": p.name,
        "العدد": p.qty,
        "الاشتراك": p.sub,
        "الإجمالي": (p.qty * p.sub),
        "رقم السريال": p.serial || p.sai || '',
        "رقم الخدمة": p.mobile || p.coords || '',
        "هوية المستخدم": p.user || p.city || '',
        "الحالة": p.status,
        "تاريخ الحالة": (p.date ? `${p.date}${p.time ? ' ' + p.time : ''}` : ''),
        "سجل المتابعة": p.rowNote || ''
    }));
    if (typeof XLSX !== 'undefined') {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "المنتجات");
        XLSX.writeFile(wb, `Order_${currentOrderId}_Products.xlsx`);
    }
}

function handleExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (typeof XLSX === 'undefined') { alert('مكتبة الإكسيل غير محملة'); return; }
    const reader = new FileReader();
    reader.onload = async (e)=>{
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type:'array'});
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(sheet, {defval:""});
            let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
            if (!dbData[currentOrderId]) dbData[currentOrderId]=[];

            const BATCH_SIZE = 400;
            let batch = db ? writeBatch(db) : null;
            let counter = 0;

            for (let row of json) {
                const docId = 'prod_' + Date.now() + '_' + Math.random().toString(36).substr(2,5) + '_' + counter;
                const prod = {
                    docId: docId,
                    orderId: currentOrderId,
                    type: row['نوع المنتج'] || 'جوال',
                    name: row['تفاصيل المنتج'] || '',
                    qty: parseInt(row['العدد']) || 1,
                    sub: parseFloat(row['الاشتراك']) || 0,
                    serial: row['رقم السريال'] || '',
                    mobile: row['رقم الخدمة'] || '',
                    user: row['هوية المستخدم'] || '',
                    status: row['الحالة'] || 'جديد',
                    date: row['تاريخ الحالة'] || getTodayFormatted(),
                    time: row['وقت الحالة'] || getTimeFormatted(),
                    rowNote: row['سجل المتابعة'] || ''
                };
                dbData[currentOrderId].push(prod);
                if (batch) {
                    batch.set(doc(db, "products", docId), prod);
                    counter++;
                    if (counter % BATCH_SIZE === 0) {
                        await batch.commit();
                        batch = writeBatch(db);
                    }
                }
            }
            if (batch && counter % BATCH_SIZE !== 0) {
                await batch.commit();
            }

            localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
            renderProducts();
            if (typeof Swal !== 'undefined') Swal.fire({icon:'success', title:'تم الاستيراد', text:`تم استيراد ${json.length} منتج`});
        } catch(err){ console.error(err); alert('خطأ في الاستيراد: '+err.message); }
    };
    reader.readAsArrayBuffer(file);
    event.target.value='';
}

function parseOrderNoteDateTime(dateStr, timeStr) {
    if (!dateStr) return new Date(NaN);
    let cleanedDate = String(dateStr).replace(/\//g, '-');
    let parts = cleanedDate.split('-');
    let year, month, day;
    if (parts.length === 3) {
        if (parts[0].length === 4) { year = parseInt(parts[0], 10); month = parseInt(parts[1], 10) - 1; day = parseInt(parts[2], 10); } 
        else { day = parseInt(parts[0], 10); month = parseInt(parts[1], 10) - 1; year = parseInt(parts[2], 10); }
    } else { return new Date(dateStr); }
    let hours = 0, minutes = 0;
    if (timeStr && timeStr.includes(':')) { let tParts = timeStr.split(':'); hours = parseInt(tParts[0], 10) || 0; minutes = parseInt(tParts[1], 10) || 0; }
    return new Date(year, month, day, hours, minutes);
}

function getGlobalNotesArray() {
    try {
        const localRaw = localStorage.getItem(GLOBAL_NOTES_KEY);
        if (localRaw) {
            const parsed = JSON.parse(localRaw);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
        const sales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        const ord = sales.find(s => String(s.id) === String(currentOrderId));
        if (ord) {
            if (Array.isArray(ord.globalNotes) && ord.globalNotes.length > 0) {
                localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(ord.globalNotes));
                return ord.globalNotes;
            }
            if (ord.notes && typeof ord.notes === 'string') {
                const parsedNotes = JSON.parse(ord.notes || '[]');
                if (Array.isArray(parsedNotes) && parsedNotes.length > 0) {
                    localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(parsedNotes));
                    return parsedNotes;
                }
            }
        }
        return localRaw ? JSON.parse(localRaw) : [];
    } catch {
        return [];
    }
}

async function syncOrderNotesToCloud(arr) {
    localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(arr));
    const btn = document.getElementById('globalNotesBtn');
    if (btn) btn.setAttribute('data-full-notes', JSON.stringify(arr));

    const lastNoteText = arr.length > 0 ? String(arr[arr.length - 1].text || '').replace(/<[^>]*>/g, '').trim() : '';

    try {
        let sales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        const idx = sales.findIndex(s => String(s.id) === String(currentOrderId));
        if (idx > -1) {
            sales[idx].globalNotes = arr;
            sales[idx].notes = JSON.stringify(arr);
            if (lastNoteText) sales[idx].note = lastNoteText;
            sales[idx].lastModifiedDate = getTodayFormatted();
            localStorage.setItem('asgate_sales_db', JSON.stringify(sales));
        }
    } catch (e) {}

    if (db && currentOrderId) {
        try {
            await setDoc(doc(db, "sales", String(currentOrderId)), {
                globalNotes: arr,
                notes: JSON.stringify(arr),
                lastModifiedDate: getTodayFormatted(),
                updatedAt: Date.now()
            }, { merge: true });
        } catch (e) {
            console.warn("إشعار حفظ ملاحظات الطلب سحابياً:", e);
        }
    }
}

function openGlobalNote() {
    const btn = document.getElementById('globalNotesBtn');
    let arr = getGlobalNotesArray();
    if (btn) btn.setAttribute('data-full-notes', JSON.stringify(arr));
    const historyLog = document.getElementById('historyLog');
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    if (historyLog) {
        historyLog.innerHTML = arr.map((msg, index) => {
            let msgDateObj = parseOrderNoteDateTime(msg.date, msg.time);
            let dayStr = isNaN(msgDateObj.getTime()) ? '' : days[msgDateObj.getDay()] + ' ';
            let userName = msg.user && msg.user !== "المستخدم" ? msg.user : "أحمد";

            return `
            <div class="note-item">
                <div class="note-header">
                    <span class="note-meta">
                        <span class="note-user"><i class="fas fa-user-circle"></i> ${escapeHTML(userName)}</span>
                        <span dir="ltr"><i class="far fa-calendar-alt"></i> ${escapeHTML(dayStr)} ${escapeHTML(formatDateDisplay(msg.date))}</span>
                        <span dir="ltr"><i class="far fa-clock"></i> ${escapeHTML(msg.time || '')}</span>
                    </span>
                    <i class="fas fa-trash-alt delete-note-btn" onclick="window.deleteGlobalNote(${index})" title="حذف الملاحظة"></i>
                </div>
                <div class="note-body">${msg.text || ''}</div>
            </div>
            `;
        }).join('') || '<div style="color:#64748b; text-align:center; font-size:11px; padding:20px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
    }
    const noteModal = document.getElementById('noteModal');
    if (noteModal) {
        noteModal.style.display = "flex";
        if (historyLog) historyLog.scrollTop = historyLog.scrollHeight;
    }
    const modalTextArea = document.getElementById('modalTextArea');
    if (modalTextArea) { modalTextArea.value = ""; modalTextArea.focus(); }
}

function closeGlobalNote() {
    const m = document.getElementById('noteModal');
    if (m) m.style.display = "none";
    const area = document.getElementById('modalTextArea');
    if (area) area.value = "";
}

async function saveGlobalNote() {
    const area = document.getElementById('modalTextArea');
    const txt = area ? area.value.trim() : "";
    closeGlobalNote();
    if (txt) {
        let arr = getGlobalNotesArray();
        let ownerName = "أحمد";
        try {
            const sales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
            const ord = sales.find(s => String(s.id) === String(currentOrderId));
            if (ord && ord.owner && ord.owner.trim() && ord.owner.trim() !== "المستخدم") {
                ownerName = ord.owner.trim();
            }
        } catch(e){}

        arr.push({
            user: ownerName,
            date: getTodayFormatted(),
            time: getTimeFormatted(),
            text: escapeHTML(txt),
            timestamp: Date.now()
        });
        addToActivityLog('سجل المتابعة', '', txt, '#' + currentOrderId);
        await syncOrderNotesToCloud(arr);
    }
}

async function deleteGlobalNote(index) {
    let confirmed = false;
    if (typeof Swal !== 'undefined') {
        const result = await Swal.fire({
            title: 'تأكيد الحذف؟',
            text: "هل أنت متأكد من حذف هذه الملاحظة؟",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#94a3b8',
            confirmButtonText: 'نعم، احذف',
            cancelButtonText: 'إلغاء'
        });
        confirmed = result.isConfirmed;
    } else {
        confirmed = confirm("هل أنت متأكد من حذف هذه الملاحظة؟");
    }
    if (confirmed) {
        let arr = getGlobalNotesArray();
        arr.splice(index, 1);
        localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(arr));
        openGlobalNote();
        await syncOrderNotesToCloud(arr);
    }
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    let fileName = prompt("أدخل اسم للمرفق لحفظه في السجل:", file.name);
    if (fileName === null) { event.target.value = ''; return; }
    if (fileName.trim() === "") fileName = file.name;
    let arr = getGlobalNotesArray();
    arr.push({
        user: "أحمد",
        date: getTodayFormatted(),
        time: getTimeFormatted(),
        text: `<i class="fas fa-file-alt"></i> تم إرفاق ملف: ${escapeHTML(fileName)}`,
        timestamp: Date.now()
    });
    await syncOrderNotesToCloud(arr);
    openGlobalNote();
    event.target.value = ''; 
}

// --- Excel Clipboard Pasting & Copying Engine ---
let lastFocusedProductCell = null;

function cleanCellText(val) {
    if (val === null || val === undefined) return '';
    let str = String(val).replace(/\u00A0/g, ' ').replace(/\u200B/g, '').trim();
    str = str.replace(/[\u0660-\u0669]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 48));
    str = str.replace(/[\u06F0-\u06F9]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 48));
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
        str = str.slice(1, -1).trim();
    }
    return str;
}

function parseClipboardExcelText(text) {
    if (!text) return [];
    let clean = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (clean.endsWith('\n')) clean = clean.slice(0, -1);
    if (!clean.trim()) return [];

    const lines = clean.split('\n');
    const hasTabs = lines.some(l => l.includes('\t'));
    if (hasTabs) {
        return lines.map(line => line.split('\t').map(c => cleanCellText(c)));
    }

    const hasCommas = lines.length > 1 && lines.every(l => l.includes(',') && !l.startsWith('#'));
    if (hasCommas) {
        return lines.map(line => line.split(',').map(c => cleanCellText(c)));
    }

    const hasMultipleSpaces = lines.length > 1 && lines.every(l => /\S\s{2,}\S/.test(l));
    if (hasMultipleSpaces) {
        return lines.map(line => line.split(/\s{2,}/).map(c => cleanCellText(c)));
    }

    return lines.map(line => [cleanCellText(line)]);
}

function extractClipboardMatrix(clipboardData) {
    if (!clipboardData) return [];

    try {
        const html = clipboardData.getData('text/html');
        if (html && (html.includes('<table') || html.includes('<tr') || html.includes('<td'))) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const trs = Array.from(doc.querySelectorAll('tr'));
            if (trs.length > 0) {
                const matrix = [];
                trs.forEach(tr => {
                    const cells = Array.from(tr.querySelectorAll('td, th'));
                    if (cells.length > 0) {
                        const rowVals = cells.map(c => cleanCellText(c.innerText || c.textContent || ''));
                        if (rowVals.some(v => v.length > 0)) {
                            matrix.push(rowVals);
                        }
                    }
                });
                if (matrix.length > 0) {
                    return matrix;
                }
            }
        }
    } catch(e) {
        console.warn("إشعار قراءة جدول HTML من البريد:", e);
    }

    const text = clipboardData.getData('text/plain') || '';
    return parseClipboardExcelText(text);
}

function isHeaderRow(row) {
    if (!row || row.length === 0) return false;
    const headerKeywords = [
        'سريال', 'شريحة', 'تسلسلي', 'serial', 'sim', 'iccid', 'imei',
        'خدمة', 'جوال', 'هاتف', 'رقم', 'mobile', 'phone', 'msisdn', 'number',
        'مستخدم', 'هوية', 'إقامة', 'user', 'id', 'national',
        'حالة', 'status', 'الاشتراك', 'اشتراك', 'sub', 'subscription', 'price',
        'عدد', 'كمية', 'qty', 'quantity', 'count',
        'منتج', 'باقة', 'تفاصيل', 'name', 'product', 'item', 'package',
        'ملاحظة', 'ملاحظات', 'note', 'notes', 'remarks',
        'مدينة', 'city', 'إحداثيات', 'coords', 'كبينة', 'sai'
    ];
    let matchCount = 0;
    row.forEach(cell => {
        const text = String(cell || '').trim().toLowerCase();
        if (headerKeywords.some(kw => text.includes(kw))) {
            matchCount++;
        }
    });
    return (matchCount >= 1 && row.some(cell => isNaN(Number(cell))));
}

function mapHeadersToFields(headerRow, currentType) {
    const isMobile = (currentType === 'جوال' || currentType === 'بيانات');
    return headerRow.map((header, idx) => {
        const h = String(header || '').trim().toLowerCase();
        if (h.includes('سريال') || h.includes('sim') || h.includes('serial') || h.includes('iccid') || h.includes('شريحة')) return isMobile ? 'serial' : 'sai';
        if (h.includes('خدمة') || h.includes('جوال') || h.includes('mobile') || h.includes('phone') || h.includes('هاتف')) return isMobile ? 'mobile' : 'coords';
        if (h.includes('مستخدم') || h.includes('هوية') || h.includes('user') || h.includes('إقامة')) return isMobile ? 'user' : 'city';
        if (h.includes('حالة') || h.includes('status')) return 'status';
        if (h.includes('اسم') || h.includes('منتج') || h.includes('باقة') || h.includes('name')) return 'name';
        if (h.includes('عدد') || h.includes('كمية') || h.includes('qty')) return 'qty';
        if (h.includes('اشتراك') || h.includes('سعر') || h.includes('sub')) return 'sub';
        if (h.includes('ملاحظ') || h.includes('note')) return 'rowNote';
        if (h.includes('مدينة') || h.includes('city')) return 'city';
        if (h.includes('كبينة') || h.includes('sai')) return 'sai';
        if (h.includes('إحداثيات') || h.includes('coords')) return 'coords';
        return idx === 0 ? (isMobile ? 'serial' : 'sai') : (idx === 1 ? (isMobile ? 'mobile' : 'coords') : 'rowNote');
    });
}

function trackProductCell(target) {
    if (!target) return;
    const el = target.nodeType === 1 ? target : target.parentElement;
    if (!el) return;
    const td = el.closest('#productsBody td');
    if (!td) return;
    const tr = td.closest('tr');
    if (!tr) return;

    document.querySelectorAll('#productsBody td.excel-active-cell').forEach(c => {
        if (c !== td) c.classList.remove('excel-active-cell');
    });
    td.classList.add('excel-active-cell');

    const colIndex = Array.from(tr.children).indexOf(td);
    const field = td.dataset.field || getFieldFromColIndex(colIndex, tr);
    const chk = tr.querySelector('.row-checkbox');
    const rowIdx = chk ? parseInt(chk.dataset.index, 10) : Array.from(tr.parentNode.children).indexOf(tr);
    lastFocusedProductCell = { tr, td, colIndex, field, rowIdx };
}

function getFieldFromColIndex(colIndex, tr) {
    const isMobileType = !tr || tr.querySelector('[data-field="serial"]') !== null;
    switch(colIndex) {
        case 1: return 'type';
        case 2: return 'name';
        case 3: return 'qty';
        case 4: return 'sub';
        case 6: return isMobileType ? 'serial' : 'sai';
        case 7: return isMobileType ? 'mobile' : 'coords';
        case 8: return isMobileType ? 'user' : 'city';
        case 9: return 'status';
        case 10: return 'date';
        case 11: return 'rowNote';
        default: return isMobileType ? 'serial' : 'sai';
    }
}

function getAdjacentFields(startField, count, currentType) {
    const isMobile = (currentType === 'جوال' || currentType === 'بيانات');
    const order = isMobile 
        ? ['name', 'qty', 'sub', 'serial', 'mobile', 'user', 'status', 'rowNote']
        : ['name', 'qty', 'sub', 'sai', 'coords', 'city', 'status', 'rowNote'];
    let startIdx = order.indexOf(startField);
    if (startIdx === -1) startIdx = isMobile ? 3 : 3;
    const result = [];
    for (let i = 0; i < count; i++) {
        if (startIdx + i < order.length) {
            result.push(order[startIdx + i]);
        } else {
            result.push('rowNote');
        }
    }
    return result;
}

function detectColumnsFromMatrix(matrix, currentType) {
    const numCols = Math.max(...matrix.map(row => row.length));
    const isMobile = (currentType === 'جوال' || currentType === 'بيانات');
    const detected = [];

    for (let c = 0; c < numCols; c++) {
        const samples = matrix.map(r => r[c]).filter(v => v !== undefined && v !== '').slice(0, 15);
        if (samples.length === 0) {
            detected.push(c === 0 ? (isMobile ? 'serial' : 'sai') : (c === 1 ? (isMobile ? 'mobile' : 'coords') : 'status'));
            continue;
        }

        let serialMatches = 0;
        let mobileMatches = 0;
        let statusMatches = 0;

        samples.forEach(val => {
            const str = String(val).trim();
            if (statusOptions.includes(str) || str.includes('مكتمل') || str.includes('معلق') || str.includes('انتظار') || str.includes('هوية')) {
                statusMatches++;
            }
            if (/^899\d{10,}/.test(str) || (str.length >= 15 && /^\d+$/.test(str))) {
                serialMatches += 2;
            } else if (/^\d{8,14}$/.test(str)) {
                if (/^(966|05)/.test(str) || str.length <= 12) mobileMatches++;
                else serialMatches++;
            }
        });

        if (statusMatches >= samples.length * 0.4) {
            detected.push('status');
        } else if (serialMatches > mobileMatches && serialMatches > 0) {
            detected.push(isMobile ? 'serial' : 'sai');
        } else if (mobileMatches > 0) {
            detected.push(isMobile ? 'mobile' : 'coords');
        } else if (c === 0) {
            detected.push(isMobile ? 'serial' : 'sai');
        } else if (c === 1) {
            detected.push(isMobile ? 'mobile' : 'coords');
        } else if (c === 2) {
            detected.push('status');
        } else {
            detected.push('user');
        }
    }
    return detected;
}

function applyFieldValue(item, field, rawVal) {
    if (!item || !field) return;
    const val = cleanCellText(rawVal);
    if (!val) return;

    if (field === 'status') {
        if (val.includes('مكتمل') || val.includes('تم') || val === 'Active') {
            item.status = 'مكتمل';
        } else if (val.includes('معلق') || val.includes('انتظار') || val.includes('هوية') || val.includes('نفاذ') || val.includes('مفوض')) {
            item.status = 'معلق';
            if (val.length > 4 && val !== 'معلق' && !item.rowNote) {
                item.rowNote = val;
            }
        } else if (val.includes('فقد') || val.includes('ملغ') || val.includes('إلغاء')) {
            item.status = 'فقدان';
        } else if (val.includes('مرتجع')) {
            item.status = 'مرتجع';
        } else if (statusOptions.includes(val)) {
            item.status = val;
        } else {
            item.status = 'معلق';
            if (!item.rowNote) item.rowNote = val;
        }
        item.date = getTodayFormatted();
        item.time = getTimeFormatted();
    } else if (field === 'date') {
        if (val.includes(' ')) {
            const parts = val.split(' ');
            item.date = parts[0];
            item.time = parts[1];
        } else {
            item.date = val;
            if (!item.time) item.time = getTimeFormatted();
        }
    } else if (field === 'qty') {
        const num = parseInt(val.replace(/[^0-9]/g, ''), 10);
        item.qty = isNaN(num) || num <= 0 ? 1 : num;
    } else if (field === 'sub') {
        const f = parseFloat(val.replace(/[^0-9.]/g, ''));
        item.sub = isNaN(f) ? 0 : f;
    } else {
        item[field] = val;
    }
}

function flashPastedRows(rowIndices, colFields) {
    setTimeout(() => {
        const rows = document.querySelectorAll('#productsBody tr');
        rowIndices.forEach(idx => {
            const tr = rows[idx];
            if (!tr) return;
            if (colFields && colFields.length > 0) {
                colFields.forEach(field => {
                    const td = tr.querySelector(`[data-field="${field}"]`);
                    if (td) {
                        td.classList.remove('excel-pasted-flash');
                        void td.offsetWidth;
                        td.classList.add('excel-pasted-flash');
                    }
                });
            } else {
                tr.classList.remove('excel-pasted-flash');
                void tr.offsetWidth;
                tr.classList.add('excel-pasted-flash');
            }
        });
    }, 60);
}

function showExcelPasteToast(message) {
    let toast = document.getElementById('excelPasteToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'excelPasteToast';
        toast.className = 'excel-paste-toast';
        document.body.appendChild(toast);
    }
    toast.innerHTML = `<i class="fas fa-check-circle" style="color: #22c55e; font-size:16px;"></i> <span>${escapeHTML(message)}</span>`;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

async function applyExcelPaste(matrix, startRowIndex = 0, startColField = 'serial', mode = 'update_and_append') {
    if (!matrix || matrix.length === 0) return;
    
    let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    if (!dbData[currentOrderId]) dbData[currentOrderId] = [];
    let items = dbData[currentOrderId];

    const sampleItem = items.length > 0 ? items[items.length - 1] : null;
    const currentType = sampleItem ? sampleItem.type : (document.getElementById('p_type') ? document.getElementById('p_type').value : 'جوال');
    const currentName = sampleItem ? sampleItem.name : 'باقة أعمال';
    const currentSub = sampleItem ? (parseFloat(sampleItem.sub) || 0) : 0;

    let colFields = [];
    if (matrix.length > 1 && isHeaderRow(matrix[0])) {
        colFields = mapHeadersToFields(matrix[0], currentType);
        matrix = matrix.slice(1);
    } else {
        const numCols = Math.max(...matrix.map(row => row.length));
        if (startColField === 'auto') {
            colFields = detectColumnsFromMatrix(matrix, currentType);
        } else if (numCols === 1) {
            colFields = [startColField];
        } else {
            colFields = getAdjacentFields(startColField, numCols, currentType);
        }
    }

    const batch = db ? writeBatch(db) : null;
    let batchCount = 0;
    const startIdx = (mode === 'append_only') ? items.length : Math.max(0, startRowIndex);
    const affectedIndices = [];

    matrix.forEach((rowValues, rOffset) => {
        const targetIdx = startIdx + rOffset;
        let item;

        if (targetIdx < items.length) {
            item = items[targetIdx];
        } else {
            const docId = 'prod_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5) + '_' + targetIdx;
            item = {
                docId: docId,
                orderId: currentOrderId,
                type: currentType,
                name: currentName,
                qty: 1,
                sub: currentSub,
                serial: '',
                mobile: '',
                user: '',
                status: 'جديد',
                date: getTodayFormatted(),
                rowNote: ''
            };
            items.push(item);
        }

        affectedIndices.push(targetIdx);

        rowValues.forEach((val, cIdx) => {
            const field = colFields[cIdx];
            if (field) applyFieldValue(item, field, val);
        });

        item.updatedAt = Date.now();
        if (batch && item.docId) {
            batch.set(doc(db, "products", item.docId), item, { merge: true });
            batchCount++;
        }
    });

    if (batch && batchCount > 0) {
        try {
            await batch.commit();
        } catch(e) {
            console.warn("إشعار الحفظ السحابي للصق من إكسيل:", e);
        }
    }

    dbData[currentOrderId] = items;
    localStorage.setItem('asgate_products_db', JSON.stringify(dbData));

    renderProducts();
    calculateTotals();
    updateStatsBox();
    updateOrderTotalHeader();

    flashPastedRows(affectedIndices, colFields);

    const colNamesAr = {
        serial: 'رقم السريال / الكبينة',
        mobile: 'رقم الخدمة / التواصل',
        user: 'هوية المستخدم / المدينة',
        status: 'الحالة',
        name: 'تفاصيل المنتج',
        qty: 'العدد',
        sub: 'الاشتراك',
        rowNote: 'سجل المتابعة'
    };
    const colDescription = colFields.map(f => colNamesAr[f] || f).join(' و ');

    showExcelPasteToast(`تم لصق ${matrix.length} خلية/صف بنجاح في عمود (${colDescription})`);
    addToActivityLog('لصق من إكسيل', '', `لصق ${matrix.length} سجل في (${colDescription})`, '');
}

async function handleTablePaste(e) {
    const active = document.activeElement;
    if (active && (
        active.id === 'liveSearch' || 
        active.id === 'modalTextArea' || 
        active.id === 'pasteExcelInput' || 
        active.id === 'p_name' || 
        active.id === 'p_sub' || 
        active.id === 'p_serial' ||
        active.id === 'p_mobile' ||
        active.id === 'p_user'
    )) {
        return;
    }

    const clickedInsideTable = e.target && e.target.closest('#productsBody, #mainTable, .table-wrapper');
    const activeInsideTable = active && active.closest('#productsBody, #mainTable, .table-wrapper');
    if (!clickedInsideTable && !activeInsideTable) return;

    const matrix = extractClipboardMatrix(e.clipboardData);
    if (!matrix || matrix.length === 0) return;

    e.preventDefault();

    trackProductCell(e.target || active);
    const startRow = lastFocusedProductCell ? lastFocusedProductCell.rowIdx : 0;
    let startField = lastFocusedProductCell ? lastFocusedProductCell.field : 'serial';
    if (!startField || startField === 'checkbox' || startField === 'type' || startField === 'total') {
        startField = 'serial';
    }

    await applyExcelPaste(matrix, startRow, startField, 'update_and_append');
}

function handleTableKeyDown(e) {
    const el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    const td = el ? el.closest('#productsBody td') : null;
    if (!td) return;
    const tr = td.closest('tr');
    if (!tr) return;

    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const colIndex = Array.from(tr.children).indexOf(td);
        const nextTr = tr.nextElementSibling;
        if (nextTr) {
            const nextTd = nextTr.children[colIndex];
            if (nextTd && nextTd.isContentEditable) {
                nextTd.focus();
            }
        }
    } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        const colIndex = Array.from(tr.children).indexOf(td);
        const prevTr = tr.previousElementSibling;
        if (prevTr) {
            const prevTd = prevTr.children[colIndex];
            if (prevTd && prevTd.isContentEditable) {
                prevTd.focus();
            }
        }
    }
}

function copySelectedToExcelClipboard() {
    const selectedBoxes = document.querySelectorAll('.row-checkbox:checked');
    if (selectedBoxes.length === 0) {
        if (typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'info',
                text: 'يرجى تحديد صف واحد على الأقل عبر مربعات الاختيار لنسخه بتنسيق إكسيل',
                confirmButtonColor: '#3b82f6'
            });
        } else {
            alert('يرجى تحديد صف واحد على الأقل عبر مربعات الاختيار لنسخه');
        }
        return;
    }

    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    const rowsText = [];
    const isMobile = dbData.length > 0 && (dbData[0].type === 'جوال' || dbData[0].type === 'بيانات');

    if (isMobile) {
        rowsText.push(['نوع المنتج', 'تفاصيل المنتج', 'العدد', 'الاشتراك', 'رقم السريال', 'رقم الخدمة', 'هوية المستخدم', 'الحالة', 'تاريخ الحالة', 'سجل المتابعة'].join('\t'));
    } else {
        rowsText.push(['نوع المنتج', 'تفاصيل المنتج', 'العدد', 'الاشتراك', 'رقم الكبينة', 'الإحداثيات', 'المدينة', 'الحالة', 'تاريخ الحالة', 'سجل المتابعة'].join('\t'));
    }

    selectedBoxes.forEach(chk => {
        const idx = parseInt(chk.dataset.index, 10);
        const item = dbData[idx];
        if (item) {
            if (isMobile) {
                rowsText.push([
                    item.type || '',
                    item.name || '',
                    item.qty || 1,
                    item.sub || 0,
                    item.serial || '',
                    item.mobile || '',
                    item.user || '',
                    item.status || '',
                    (item.date ? `${item.date}${item.time ? ' ' + item.time : ''}` : ''),
                    item.rowNote || ''
                ].join('\t'));
            } else {
                rowsText.push([
                    item.type || '',
                    item.name || '',
                    item.qty || 1,
                    item.sub || 0,
                    item.sai || '',
                    item.coords || '',
                    item.city || '',
                    item.status || '',
                    (item.date ? `${item.date}${item.time ? ' ' + item.time : ''}` : ''),
                    item.rowNote || ''
                ].join('\t'));
            }
        }
    });

    const clipboardStr = rowsText.join('\n');
    navigator.clipboard.writeText(clipboardStr).then(() => {
        showExcelPasteToast(`تم نسخ ${selectedBoxes.length} صف إلى الحافظة بتنسيق Excel`);
        addToActivityLog('نسخ Excel', '', `نسخ ${selectedBoxes.length} صف للحافظة`, '');
    }).catch(err => {
        console.warn('فشل النسخ إلى الحافظة:', err);
    });
}

function openPasteExcelModal() {
    const modal = document.getElementById('pasteExcelModal');
    if (!modal) return;
    modal.style.display = 'flex';
    const textarea = document.getElementById('pasteExcelInput');
    if (textarea) {
        textarea.value = '';
        setTimeout(() => textarea.focus(), 100);
    }
    const preview = document.getElementById('pastePreviewSummary');
    if (preview) preview.style.display = 'none';
}

function closePasteExcelModal() {
    const modal = document.getElementById('pasteExcelModal');
    if (!modal) return;
    modal.style.display = 'none';
}

function handlePasteModalInput() {
    const text = document.getElementById('pasteExcelInput')?.value || '';
    const matrix = parseClipboardExcelText(text);
    const summary = document.getElementById('pastePreviewSummary');
    const textEl = document.getElementById('pastePreviewText');
    if (!summary || !textEl) return;
    if (matrix.length > 0) {
        const cols = Math.max(...matrix.map(r => r.length));
        textEl.innerText = `تم رصد ${matrix.length} سطر و ${cols} عمود جاهز للصق في الجدول`;
        summary.style.display = 'block';
    } else {
        summary.style.display = 'none';
    }
}

async function submitPasteExcelModal() {
    const text = document.getElementById('pasteExcelInput')?.value || '';
    const matrix = parseClipboardExcelText(text);
    if (matrix.length === 0) {
        if (typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'warning', text: 'يرجى لصق بيانات إكسيل أولاً في المربع', confirmButtonColor: '#3b82f6' });
        } else {
            alert('يرجى لصق بيانات إكسيل أولاً');
        }
        return;
    }
    const targetCol = document.getElementById('pasteTargetCol')?.value || 'auto';
    const mode = document.getElementById('pasteApplyMode')?.value || 'update_and_append';
    closePasteExcelModal();
    await applyExcelPaste(matrix, 0, targetCol, mode);
}

window.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.multi-select-menu.show').forEach(m => {
            m.classList.remove('show');
            const w = m.closest('.custom-filter-wrapper');
            if (w) w.classList.remove('active');
        });
    }
    if (e.target.id === 'productModal') closeModal();
    if (e.target.id === 'noteModal') closeGlobalNote();
    if (e.target.id === 'pasteExcelModal') closePasteExcelModal();
});

document.addEventListener('focusin', (e) => trackProductCell(e.target));
document.addEventListener('click', (e) => trackProductCell(e.target));
document.addEventListener('paste', handleTablePaste);
document.addEventListener('keydown', handleTableKeyDown);

Object.assign(window, {
    toggleLogExpansion,
    addToActivityLog,
    triggerActionLog,
    loadOrderDetails,
    validateNumberInput,
    updateTableHeaders,
    updateField,
    changeStatus,
    deleteSelected,
    calculateTotals,
    saveProduct,
    applyFilters,
    toggleAll,
    openModal,
    closeModal,
    handleTypeChange,
    exportToExcel,
    handleExcelImport,
    openGlobalNote,
    closeGlobalNote,
    saveGlobalNote,
    deleteGlobalNote,
    handleFileUpload,
    toggleCustomFilter,
    selectAllFilter,
    clearAllFilter,
    updateStatusFilters,
    updateMasterCheckboxState,
    isRowVisible,
    setupScrollSync,
    formatDateDisplay,
    formatTimeDisplay,
    getTodayFormatted,
    getTimeFormatted,
    updateOrderTotalHeader,
    toggleDateSort,
    setDateSort,
    parseProductDate,
    trackProductCell,
    applyExcelPaste,
    copySelectedToExcelClipboard,
    openPasteExcelModal,
    closePasteExcelModal,
    handlePasteModalInput,
    submitPasteExcelModal,
    compareSerials,
    getSequentialSerial
});

function checkUrlHighlight() {
    const urlParams = new URLSearchParams(window.location.search);
    const highlightId = urlParams.get('highlight');
    if (highlightId) {
        setTimeout(() => {
            const headerInfo = document.querySelector('.order-header-info');
            if (headerInfo) {
                headerInfo.classList.remove('highlight-pulse-card');
                void headerInfo.offsetWidth;
                headerInfo.classList.add('highlight-pulse-card');
                setTimeout(() => headerInfo.classList.remove('highlight-pulse-card'), 2800);
            }
        }, 500);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadOrderDetails();
    checkUrlHighlight();
});
