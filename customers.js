// =========================================================================
// customers.js - إدارة العملاء سحابياً ومحلياً (نظام ASGate CRM)
// استراتيجية ترشيد الكوتا (Zero-Waste Firebase Quota):
// 1. قراءة فورية من الكاش المحلي (crm_customers) قبل أي اتصال سحابي
// 2. تحديث فوري للكاش المحلي مع تأخير (Debounce) إرسال التعديلات لفايربيز
// 3. منع تكرار العميل نهائياً بناء على السجل التجاري (الرئيسي أو الآخر)
// 4. تتبع العميل ونشاطه وحالته عبر رقم السجل وليس الاسم
// =========================================================================

import Swal from 'sweetalert2';
import * as XLSX from 'xlsx';
window.Swal = Swal;
window.XLSX = XLSX;

import { db, collection, onSnapshot, doc, setDoc, updateDoc, writeBatch } from './firebase-config.js';
import { getCustomerDateColorAndStatus, parseDateToTimestamp, isCustomerMatchedByCr, checkCustomerCrDuplicate, normalizeCr, createActivityLogEntry, renderActivityLogsHTML } from './src/crm_logic.js';

const SafeSwal = {
    fire: async (opt1, opt2, opt3) => {
        if (typeof window.Swal !== 'undefined') {
            return window.Swal.fire(opt1, opt2, opt3);
        }
        let title = typeof opt1 === 'object' ? opt1.title : opt1;
        let text = typeof opt1 === 'object' ? opt1.text : opt2;
        let isConfirm = typeof opt1 === 'object' ? opt1.showCancelButton : false;
        if (isConfirm) {
            const confirmed = window.confirm((title ? title + "\n" : "") + (text || ""));
            return { isConfirmed: confirmed, value: confirmed };
        }
        window.alert((title ? title + "\n" : "") + (text || ""));
        return { isConfirmed: true };
    }
};

let tableBody, logsBody, totalCustomers, monthCustomers, todayCustomers, searchInput;

let searchTimeout;
let customersDataList = [];
let logsDataList = [];

let activeCategoryFilters = new Set();
let totalCategoryOptionsCount = 0;

let activeStatusFilters = new Set();
let totalStatusOptionsCount = 0;

let activeOwnerFilters = new Set();
let totalOwnerOptionsCount = 0;

let isFilterInitialized = false;

function initDomReferences() {
    tableBody = document.getElementById('tableBody');
    logsBody = document.getElementById('activityList');
    totalCustomers = document.getElementById('stat-total');
    monthCustomers = document.getElementById('stat-month');
    todayCustomers = document.getElementById('stat-today');
    searchInput = document.getElementById('searchInput');
}

function getTodayFormatted() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTimeFormatted() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function normalizeDateString(dateStr) {
    if (!dateStr) return '';
    let clean = String(dateStr).trim().replace(/\//g, '-').split(' ')[0].split('T')[0];
    const parts = clean.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) {
            return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
        }
        return `${parts[2]}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
    }
    return clean;
}

function formatDateDisplay(dateString) {
    if (!dateString) return '-';
    const norm = normalizeDateString(dateString);
    const parts = norm.split('-');
    if (parts.length === 3) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateString;
}

function getMonthYearArabic(dateString) {
    if (!dateString) return 'غير محدد';
    const norm = normalizeDateString(dateString);
    const parts = norm.split('-');
    
    let y, m;
    if (parts.length === 3) {
        y = parts[0];
        m = parts[1];
    } else {
        const d = new Date(dateString);
        if (!isNaN(d.getTime())) {
            y = d.getFullYear();
            m = d.getMonth() + 1;
        } else {
            return 'غير محدد';
        }
    }
    
    const monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    let mIndex = parseInt(m, 10) - 1;
    if (mIndex >= 0 && mIndex < 12) {
        return `${monthNames[mIndex]} ${y}`;
    }
    return 'غير محدد';
}

function normalizeText(v) { return String(v || '').toLowerCase().trim(); }

function escapeHTML(str) { 
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({ 
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' 
    }[tag])); 
}

function safe(value, fallback = '-') { 
    return escapeHTML(value && String(value).trim() ? String(value).trim() : fallback); 
}

function badgeClass(status) {
    const s = normalizeText(status);
    if (s.includes('غير نشط')) return 'status-cust-inactive';
    if (s === 'نشط' || (s.includes('نشط') && !s.includes('غير'))) return 'status-cust-active';
    if (s.includes('موقوف')) return 'status-cust-paused';
    if (s.includes('فقدان') || s.includes('فاقد')) return 'status-cust-lost';
    if (['مغلق', 'ملغي'].some(word => s.includes(word))) return 'status-cust-lost';
    return 'status-cust-active';
}

function classBadgeColor(classification) {
    return 'status-class-plain';
}

function getDisplayManager(v) { return safe(v.delegatePriority && v.delegateName ? v.delegateName : v.mgr); }
function getDisplayMobile(v) { return safe(v.delegatePriority && v.delegateMob ? v.delegateMob : v.mob); }
function getDisplayEmail(v) { return safe(v.delegatePriority && v.delegateEmail ? v.delegateEmail : v.email); }

function getCustomerActivityColorAndStatus(customer) {
    if (!customer) {
        return {
            latestTimestamp: 0,
            daysSince: 999,
            color: '#C00000',
            badgeClass: 'date-color-red',
            isInactiveDueToTime: true
        };
    }

    let timestamps = [];

    // 1. التاريخ الخاص بالعميل (آخر نشاط، تحديث، تاريخ الإنشاء)
    if (customer.lastActivityDate) timestamps.push(parseDateToTimestamp(customer.lastActivityDate));
    if (customer.updatedAt) timestamps.push(parseDateToTimestamp(customer.updatedAt));
    if (customer.lastUpdate) timestamps.push(parseDateToTimestamp(customer.lastUpdate));
    if (customer.date) timestamps.push(parseDateToTimestamp(customer.date));
    if (customer.creationDate) timestamps.push(parseDateToTimestamp(customer.creationDate));

    // سجل ملاحظات العميل
    if (customer.notesHistory && Array.isArray(customer.notesHistory)) {
        customer.notesHistory.forEach(n => {
            if (n.timestamp) timestamps.push(parseDateToTimestamp(n.timestamp));
            if (n.date) timestamps.push(parseDateToTimestamp(n.date));
        });
    }

    // 2. تتبع الزيارات الخاصة بالعميل برقم السجل التجاري بدقة تامة وليس بالاسم
    try {
        const rawVisits = localStorage.getItem('asgate_visits_local_cache_v1');
        if (rawVisits) {
            const parsed = JSON.parse(rawVisits);
            const allVisits = Array.isArray(parsed) ? parsed : Object.values(parsed);
            allVisits.forEach(v => {
                if (isCustomerMatchedByCr(customer, v)) {
                    if (v.editDate) timestamps.push(parseDateToTimestamp(v.editDate));
                    if (v.visitDate) timestamps.push(parseDateToTimestamp(v.visitDate));
                    if (v.createdAt) timestamps.push(parseDateToTimestamp(v.createdAt));
                }
            });
        }
    } catch(e) {}

    // 3. تتبع الفرص البيعية الخاصة بالعميل برقم السجل التجاري
    try {
        const rawOpps = localStorage.getItem('asgate_opportunities_local_cache_v1');
        if (rawOpps) {
            const parsed = JSON.parse(rawOpps);
            const allOpps = Array.isArray(parsed) ? parsed : Object.values(parsed);
            allOpps.forEach(o => {
                if (isCustomerMatchedByCr(customer, o)) {
                    if (o.editDate) timestamps.push(parseDateToTimestamp(o.editDate));
                    if (o.oppDate) timestamps.push(parseDateToTimestamp(o.oppDate));
                    if (o.expDate) timestamps.push(parseDateToTimestamp(o.expDate));
                }
            });
        }
    } catch(e) {}

    // 4. تتبع طلبات المبيعات الخاصة بالعميل برقم السجل التجاري
    try {
        const allSales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        if (Array.isArray(allSales)) {
            allSales.forEach(s => {
                if (isCustomerMatchedByCr(customer, s)) {
                    if (s.date) timestamps.push(parseDateToTimestamp(s.date));
                    if (s.timestamp) timestamps.push(parseDateToTimestamp(s.timestamp));
                    if (s.editDate) timestamps.push(parseDateToTimestamp(s.editDate));
                    if (s.lastModifiedDate) timestamps.push(parseDateToTimestamp(s.lastModifiedDate));
                }
            });
        }
    } catch(e) {}

    const valid = timestamps.filter(t => t > 0);
    const latestTimestamp = valid.length > 0 ? Math.max(...valid) : 0;

    return getCustomerDateColorAndStatus(latestTimestamp, new Date());
}

function isRowVisible(tr) {
    if (!tr) return false;
    if (tr.style.display === 'none') return false;
    if (tr.classList.contains('hidden')) return false;
    if (tr.offsetParent === null && window.getComputedStyle(tr).display === 'none') return false;
    return true;
}

function updateMasterCheckboxState() {
    const masterCb = document.querySelector('th.col-select input[type="checkbox"], #masterCheckbox');
    if (!masterCb) return;

    if (!tableBody) tableBody = document.getElementById('tableBody');
    if (!tableBody) return;

    const visibleRows = Array.from(tableBody.querySelectorAll('tr.main-row')).filter(isRowVisible);
    if (visibleRows.length === 0) {
        masterCb.checked = false;
        masterCb.indeterminate = false;
        return;
    }

    const visibleCheckboxes = visibleRows.map(tr => tr.querySelector('.select-check')).filter(Boolean);
    const checkedCount = visibleCheckboxes.filter(cb => cb.checked).length;

    if (checkedCount === 0) {
        masterCb.checked = false;
        masterCb.indeterminate = false;
    } else if (checkedCount === visibleCheckboxes.length) {
        masterCb.checked = true;
        masterCb.indeterminate = false;
    } else {
        masterCb.checked = false;
        masterCb.indeterminate = true;
    }
}

function toggleAllCheckboxes(masterCheckbox) {
    const isChecked = !!(masterCheckbox && masterCheckbox.checked);
    if (!tableBody) tableBody = document.getElementById('tableBody');
    if (!tableBody) return;

    const rows = tableBody.querySelectorAll('tr.main-row');
    rows.forEach(tr => {
        const cb = tr.querySelector('.select-check');
        if (!cb) return;

        if (isRowVisible(tr)) {
            cb.checked = isChecked;
        } else {
            cb.checked = false;
        }
    });

    updateMasterCheckboxState();
}

function getSelectedVisibleCodes() {
    if (!tableBody) tableBody = document.getElementById('tableBody');
    if (!tableBody) return [];

    const checkedBoxes = tableBody.querySelectorAll('tr.main-row .select-check:checked');
    return Array.from(checkedBoxes)
        .filter(cb => {
            const tr = cb.closest('tr');
            return isRowVisible(tr);
        })
        .map(cb => cb.getAttribute('data-code'))
        .filter(Boolean);
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
    const checkboxes = menu.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
    updateFilters();
}

function clearAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const checkboxes = menu.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    updateFilters();
}

function populateFilterOptions() {
    const categoryContainer = document.getElementById('categoryFilterItemsContainer');
    if (categoryContainer) {
        const predefinedCategories = ['حكومي', 'مهم', 'كبير', 'متوسط', 'صغير', 'جديد'];
        const existingCategories = new Set(predefinedCategories);
        customersDataList.forEach(c => {
            const cat = String(c.classification || c.source || '').trim();
            if (cat) existingCategories.add(cat);
        });

        const currentChecked = new Set();
        let wasAllCategoryChecked = false;
        if (isFilterInitialized) {
            const allCatCbs = categoryContainer.querySelectorAll('input[type="checkbox"]');
            allCatCbs.forEach(cb => { if (cb.checked) currentChecked.add(cb.value); });
            wasAllCategoryChecked = (allCatCbs.length > 0 && currentChecked.size === allCatCbs.length);
        }

        const orderedCategories = [];
        predefinedCategories.forEach(cat => {
            if (!orderedCategories.includes(cat)) orderedCategories.push(cat);
        });
        existingCategories.forEach(cat => {
            if (!orderedCategories.includes(cat)) orderedCategories.push(cat);
        });

        categoryContainer.innerHTML = '';
        orderedCategories.forEach(cat => {
            const isChecked = !isFilterInitialized || wasAllCategoryChecked || currentChecked.has(cat);
            const label = document.createElement('label');
            label.className = 'multi-select-item';
            label.innerHTML = `
                <input type="checkbox" value="${escapeHTML(cat)}" ${isChecked ? 'checked' : ''} onchange="updateFilters()">
                <span class="custom-cb"><i class="fas fa-check"></i></span>
                <span>${escapeHTML(cat)}</span>
            `;
            categoryContainer.appendChild(label);
        });
        totalCategoryOptionsCount = orderedCategories.length;
    }

    const statusContainer = document.getElementById('statusFilterItemsContainer');
    if (statusContainer) {
        const predefinedStatuses = ['نشط', 'موقوف مؤقت', 'غير نشط', 'فقدان'];
        const existingStatuses = new Set(predefinedStatuses);
        customersDataList.forEach(c => {
            const st = String(c.status || '').trim();
            if (st) existingStatuses.add(st);
        });

        const currentChecked = new Set();
        let wasAllStatusChecked = false;
        if (isFilterInitialized) {
            const allStatCbs = statusContainer.querySelectorAll('input[type="checkbox"]');
            allStatCbs.forEach(cb => { if (cb.checked) currentChecked.add(cb.value); });
            wasAllStatusChecked = (allStatCbs.length > 0 && currentChecked.size === allStatCbs.length);
        }

        const orderedStatuses = [];
        predefinedStatuses.forEach(st => {
            if (!orderedStatuses.includes(st)) orderedStatuses.push(st);
        });
        existingStatuses.forEach(st => {
            if (!orderedStatuses.includes(st)) orderedStatuses.push(st);
        });

        statusContainer.innerHTML = '';
        orderedStatuses.forEach(st => {
            const isChecked = !isFilterInitialized || wasAllStatusChecked || currentChecked.has(st);
            const label = document.createElement('label');
            label.className = 'multi-select-item';
            label.innerHTML = `
                <input type="checkbox" value="${escapeHTML(st)}" ${isChecked ? 'checked' : ''} onchange="updateFilters()">
                <span class="custom-cb"><i class="fas fa-check"></i></span>
                <span>${escapeHTML(st)}</span>
            `;
            statusContainer.appendChild(label);
        });
        totalStatusOptionsCount = orderedStatuses.length;
    }

    const ownerContainer = document.getElementById('ownerFilterItemsContainer');
    if (ownerContainer) {
        const existingOwners = new Set(['المستخدم', 'أحمد الحربي', 'محمد القحطاني', 'خالد الشمري', 'سارة العتيبي']);
        customersDataList.forEach(c => {
            const ow = String(c.owner || '').trim();
            if (ow) existingOwners.add(ow);
        });

        const currentChecked = new Set();
        let wasAllOwnerChecked = false;
        if (isFilterInitialized) {
            const allOwnerCbs = ownerContainer.querySelectorAll('input[type="checkbox"]');
            allOwnerCbs.forEach(cb => { if (cb.checked) currentChecked.add(cb.value); });
            wasAllOwnerChecked = (allOwnerCbs.length > 0 && currentChecked.size === allOwnerCbs.length);
        }

        ownerContainer.innerHTML = '';
        Array.from(existingOwners).forEach(ow => {
            const isChecked = !isFilterInitialized || wasAllOwnerChecked || currentChecked.has(ow);
            const label = document.createElement('label');
            label.className = 'multi-select-item';
            label.innerHTML = `
                <input type="checkbox" value="${escapeHTML(ow)}" ${isChecked ? 'checked' : ''} onchange="updateFilters()">
                <span class="custom-cb"><i class="fas fa-check"></i></span>
                <span>${escapeHTML(ow)}</span>
            `;
            ownerContainer.appendChild(label);
        });
        totalOwnerOptionsCount = existingOwners.size;
    }

    isFilterInitialized = true;
    updateFilters();
}

function updateFilters() {
    const catMenu = document.getElementById('categoryFilterMenu');
    let catChecked = [];
    if (catMenu) {
        const cbs = catMenu.querySelectorAll('#categoryFilterItemsContainer input[type="checkbox"]');
        totalCategoryOptionsCount = cbs.length;
        cbs.forEach(cb => { if (cb.checked) catChecked.push(normalizeText(cb.value)); });
        activeCategoryFilters = new Set(catChecked);
        const catDot = document.getElementById('categoryFilterDot');
        if (catDot) {
            catDot.style.display = (catChecked.length < totalCategoryOptionsCount) ? 'inline-block' : 'none';
        }
    }

    const statMenu = document.getElementById('statusFilterMenu');
    let statChecked = [];
    if (statMenu) {
        const cbs = statMenu.querySelectorAll('#statusFilterItemsContainer input[type="checkbox"]');
        totalStatusOptionsCount = cbs.length;
        cbs.forEach(cb => { if (cb.checked) statChecked.push(normalizeText(cb.value)); });
        activeStatusFilters = new Set(statChecked);
        const statDot = document.getElementById('statusFilterDot');
        if (statDot) {
            statDot.style.display = (statChecked.length < totalStatusOptionsCount) ? 'inline-block' : 'none';
        }
    }

    const ownerMenu = document.getElementById('ownerFilterMenu');
    let ownerChecked = [];
    if (ownerMenu) {
        const cbs = ownerMenu.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]');
        totalOwnerOptionsCount = cbs.length;
        cbs.forEach(cb => { if (cb.checked) ownerChecked.push(normalizeText(cb.value)); });
        activeOwnerFilters = new Set(ownerChecked);
        const ownerDot = document.getElementById('ownerFilterDot');
        if (ownerDot) {
            ownerDot.style.display = (ownerChecked.length < totalOwnerOptionsCount) ? 'inline-block' : 'none';
        }
    }

    filterAndRenderCustomers();
}

function filterAndRenderCustomers() {
    const q = normalizeText(searchInput ? searchInput.value : '');

    const filtered = customersDataList.filter(v => {
        if (totalCategoryOptionsCount > 0) {
            if (activeCategoryFilters.size === 0) {
                return false;
            }
            if (activeCategoryFilters.size < totalCategoryOptionsCount) {
                const rawCat = normalizeText(v.classification || v.source || 'غير محدد');
                let matchesCat = false;
                for (let filterVal of activeCategoryFilters) {
                    if (rawCat === filterVal || rawCat.includes(filterVal) || filterVal.includes(rawCat)) {
                        matchesCat = true;
                        break;
                    }
                }
                if (!matchesCat) return false;
            }
        }

        if (totalStatusOptionsCount > 0) {
            if (activeStatusFilters.size === 0) {
                return false;
            }
            if (activeStatusFilters.size < totalStatusOptionsCount) {
                const rawStat = normalizeText(v.status || 'جديد');
                let matchesStat = false;
                for (let filterVal of activeStatusFilters) {
                    if (rawStat === filterVal || rawStat.includes(filterVal) || filterVal.includes(rawStat)) {
                        matchesStat = true;
                        break;
                    }
                }
                if (!matchesStat) return false;
            }
        }

        if (totalOwnerOptionsCount > 0) {
            if (activeOwnerFilters.size === 0) {
                return false;
            }
            if (activeOwnerFilters.size < totalOwnerOptionsCount) {
                const rawOwner = normalizeText(v.owner || 'المستخدم');
                let matchesOwner = false;
                for (let filterVal of activeOwnerFilters) {
                    if (rawOwner === filterVal || rawOwner.includes(filterVal)) {
                        matchesOwner = true;
                        break;
                    }
                }
                if (!matchesOwner) return false;
            }
        }

        if (q) {
            const haystack = [
                v.code, v.comp, v.address, v.city, v.mgr, v.delegateName,
                v.mob, v.delegateMob, v.email, v.delegateEmail, v.cr, v.cr1, v.status,
                v.owner, v.classification, v.notesText, v.lastNote
            ].map(normalizeText).join(' ');
            if (!haystack.includes(q)) return false;
        }

        return true;
    });

    renderCustomers(filtered);
}

function saveLocalBackup() {
    try {
        localStorage.setItem('crm_customers', JSON.stringify(customersDataList));
        localStorage.setItem('asgate_customers_cache_v1', JSON.stringify(customersDataList));
        localStorage.setItem('crm_activity_logs', JSON.stringify(logsDataList));
    } catch (e) {
        console.error("Local Storage Error: ", e);
    }
}

function loadSavedData() {
    const localCust = localStorage.getItem('crm_customers') || localStorage.getItem('asgate_customers_cache_v1');
    const localLogs = localStorage.getItem('crm_activity_logs');
    
    if (localCust) {
        try { 
            customersDataList = JSON.parse(localCust); 
        } catch(e){}
    }
    if (localLogs) {
        try { 
            logsDataList = JSON.parse(localLogs); 
        } catch(e){}
    }

    if (!customersDataList || customersDataList.length === 0) {
        customersDataList = [
            {
                code: "CUST-00001", comp: "شركة الأفق للحلول الرقمية", city: "الرياض", address: "الصحافة",
                mgr: "فهد العتيبي", mob: "0501234567", email: "info@alofooq.sa", cr: "1010345678", cr1: "1010345678",
                date: "2026-01-14", creationDate: "2026-01-14", classification: "مهم", status: "نشط",
                owner: "أحمد الحربي", notesText: "تم توقيع العقد السنوي للخدمات التقنية.", notesHistory: []
            },
            {
                code: "CUST-00002", comp: "مستشفى الرعاية المتقدمة", city: "جدة", address: "الحمراء",
                mgr: "د. طارق الغامدي", mob: "0552345678", email: "tariq@advancedcare.med", cr: "4030112233", cr1: "4030112233",
                date: "2026-01-20", creationDate: "2026-01-20", classification: "مهم", status: "نشط",
                owner: "محمد القحطاني", notesText: "متابعة تجهيز أنظمة الربط الطبي.", notesHistory: []
            },
            {
                code: "CUST-00003", comp: "وزارة الموارد البشرية (فرع)", city: "الرياض", address: "المعذر",
                mgr: "سلطان الدوسري", mob: "0543456789", email: "sdosari@hr.gov.sa", cr: "7001234567", cr1: "7001234567",
                date: "2026-01-28", creationDate: "2026-01-28", classification: "حكومي", status: "نشط",
                owner: "أحمد الحربي", notesText: "اعتماد المحضر النهائي للمشروع الحكومي.", notesHistory: []
            },
            {
                code: "CUST-00004", comp: "مجموعة البناء الحديث للمقاولات", city: "الدمام", address: "الشاطئ",
                mgr: "م. حسام الزهراني", mob: "0564567890", email: "husam@modernbuild.com", cr: "2050987654", cr1: "2050987654",
                date: "2026-02-05", creationDate: "2026-02-05", classification: "متوسط", status: "غير نشط",
                owner: "خالد الشمري", notesText: "تأجيل التجديد لحين انتهاء موسم الصيف.", notesHistory: []
            },
            {
                code: "CUST-00005", comp: "مؤسسة الابتكار للتجارة", city: "المدينة المنورة", address: "قباء",
                mgr: "صالح المولد", mob: "0575678901", email: "saleh@ebtekar.com", cr: "4650334455", cr1: "4650334455",
                date: "2026-02-12", creationDate: "2026-02-12", classification: "صغير", status: "نشط",
                owner: "سارة العتيبي", notesText: "تم إرسال عرض السعر المبدئي ومناقشة الخصم.", notesHistory: []
            }
        ];
        saveLocalBackup();
    }

    updateStats(customersDataList);
    populateFilterOptions();
    renderLogs(logsDataList);

    try {
        if (db) {
            const customersRef = collection(db, "customers");
            onSnapshot(customersRef, (querySnapshot) => {
                if (querySnapshot && !querySnapshot.empty) {
                    const freshCustomers = querySnapshot.docs.map(docSnap => {
                        const data = docSnap.data();
                        data.code = docSnap.id || data.code;
                        return data;
                    });
                    
                    customersDataList = freshCustomers;
                    saveLocalBackup();
                    updateStats(customersDataList);
                    populateFilterOptions();
                }
            }, (err) => {
                console.warn("Cloud snapshot notice: ", err);
            });

            const custLogsRef = collection(db, "customers_activity_logs");
            onSnapshot(custLogsRef, (logsSnap) => {
                if (logsSnap && !logsSnap.empty) {
                    const freshLogs = [];
                    logsSnap.forEach(d => freshLogs.push(d.data()));
                    freshLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                    logsDataList = freshLogs.slice(0, 100);
                    saveLocalBackup();
                    renderLogs(logsDataList);
                }
            }, (err) => {
                console.warn("Cloud customer logs snapshot notice: ", err);
            });
        }
    } catch (error) {
        console.warn("Notice: Operating with local storage.", error);
    }
}

function renderCustomers(list) {
    if (!tableBody) tableBody = document.getElementById('tableBody');
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    if (!list.length) {
        tableBody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:28px;color:var(--text-muted);font-weight:700;">لا توجد بيانات مطابقة للفرز والبحث</td></tr>`;
        updateMasterCheckboxState();
        return;
    }
    
    const sortedList = [...list].sort((a, b) => {
        let dA = normalizeDateString(a.creationDate || a.date || '');
        let dB = normalizeDateString(b.creationDate || b.date || '');
        return dB.localeCompare(dA);
    });
    
    let currentMonthYear = '';
    let hasStatusChanged = false;

    sortedList.forEach(v => {
        const colorInfo = getCustomerActivityColorAndStatus(v);

        // إذا مر أكثر من 60 يوم دون أي طلب أو نشاط برقم السجل تتحول حالة العميل تلقائياً إلى: غير نشط
        if (colorInfo.isInactiveDueToTime) {
            const currentNormStatus = normalizeText(v.status);
            if (currentNormStatus === 'نشط' || !v.status || currentNormStatus === 'جديد') {
                v.status = 'غير نشط';
                v.autoDeactivated = true;
                hasStatusChanged = true;
            }
        }

        const rowMonthYear = getMonthYearArabic(v.creationDate || v.date);
        
        if (rowMonthYear !== currentMonthYear && rowMonthYear !== 'غير محدد') {
            const sepTr = document.createElement('tr');
            sepTr.className = 'month-separator-row';
            sepTr.innerHTML = `<td colspan="13" style="pointer-events: none;"><span class="month-badge">${escapeHTML(rowMonthYear)}</span></td>`;
            tableBody.appendChild(sepTr);
            currentMonthYear = rowMonthYear;
        }

        const classification = safe(v.classification || v.source || 'غير محدد');
        let lastNotePreview = (v.notesHistory && v.notesHistory.length) 
            ? v.notesHistory[v.notesHistory.length - 1].text 
            : (v.notesText || 'اضغط لإضافة ملاحظة');

        const sNorm = normalizeText(v.status);
        const isInactiveOrLost = sNorm.includes('غير نشط') || sNorm.includes('فقدان') || sNorm.includes('فاقد') || sNorm.includes('مغلق') || sNorm.includes('ملغي');

        const tr = document.createElement('tr');
        tr.className = 'main-row' + (isInactiveOrLost ? ' closed-row row-shrink ' + (sNorm.includes('غير نشط') ? 'row-inactive' : 'row-lost') : '');
        tr.id = `row-${v.code}`;
        tr.innerHTML = `
            <td class="col-select"><input type="checkbox" class="select-check" data-code="${escapeHTML(v.code)}"></td>
            <td class="col-code"><a href="customer-details.html?code=${escapeHTML(v.code)}" onclick="event.preventDefault(); window.openCustomerDetails('${escapeHTML(v.code)}')" class="code-link">${safe(v.code, '00001')}</a></td>
            <td class="col-company" title="${safe(v.comp)}">
                <span class="text-truncate" title="${safe(v.comp)}"><strong>${safe(v.comp)}</strong></span>
            </td>
            <td class="col-address"><span class="text-truncate">${safe(v.city)}</span></td>
            <td class="col-manager"><span class="text-truncate">${getDisplayManager(v)}</span></td>
            <td class="col-mobile">
                <div class="phone-cell-container">
                    ${getDisplayMobile(v)}
                    <a href="https://wa.me/${getDisplayMobile(v).replace(/\D/g,'')}" target="_blank" class="whatsapp-icon-btn" onclick="event.stopPropagation()"><i class="fab fa-whatsapp"></i></a>
                </div>
            </td>
            <td class="col-email"><span class="text-truncate">${getDisplayEmail(v)}</span></td>
            <td class="col-main-cr">${safe(v.cr1 || v.cr, '-')}</td>
            <td class="col-date" dir="ltr" style="text-align: center;">
                <strong class="${colorInfo.badgeClass}" style="color: ${colorInfo.color} !important;">${formatDateDisplay(v.creationDate || v.date)}</strong>
            </td>
            <td class="col-class"><span class="${classBadgeColor(classification)}" style="padding: 2px 8px; border-radius: 4px;">${classification}</span></td>
            <td class="col-notes"><div class="notes-preview" data-code="${escapeHTML(v.code)}" onclick="window.openNote('${escapeHTML(v.code)}'); event.stopPropagation()">${safe(lastNotePreview)}</div></td>
            <td class="col-status"><span class="${badgeClass(v.status)}" style="padding: 2px 8px; border-radius: 4px;">${safe(v.status, 'جديد')}</span></td>
            <td class="col-user"><input type="text" class="owner-inline-input" data-code="${escapeHTML(v.code)}" value="${safe(v.owner)}" placeholder="مندوب" onchange="window.updateCustomerOwner('${escapeHTML(v.code)}', this.value)" onfocus="this.select()" onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}" onclick="event.stopPropagation()"></td>
        `;
        tableBody.appendChild(tr);
    });

    if (hasStatusChanged) {
        saveLocalBackup();
        populateFilterOptions();
    }

    updateMasterCheckboxState();

    const highlightId = new URLSearchParams(window.location.search).get('highlight');
    if (highlightId && typeof window.triggerElementHighlight === 'function') {
        setTimeout(() => window.triggerElementHighlight(highlightId), 80);
    }
}

function renderLogs(list) {
    if (!logsBody) logsBody = document.getElementById('activityList');
    if (!logsBody) return;
    logsBody.innerHTML = renderActivityLogsHTML(list, 'customers');
}

async function addToActivityLog(fieldName, oldVal, newVal, targetName, user = 'المستخدم') { 
    const logEntry = createActivityLogEntry({
        page: 'customers',
        fieldName,
        oldVal,
        newVal,
        identifierValue: targetName,
        user
    });
    if (!logEntry) return;

    logsDataList.unshift(logEntry);
    logsDataList = logsDataList.slice(0, 100);
    saveLocalBackup();
    renderLogs(logsDataList);
    try {
        if (db) await setDoc(doc(db, "customers_activity_logs", logEntry.timestamp.toString()), logEntry);
    } catch (e) {}
}
window.addToActivityLog = addToActivityLog;

function updateStats(list) {
    const todayISO = getTodayFormatted();
    const todayDisplay = formatDateDisplay(todayISO);
    const currentYearMonth = todayISO.substring(0, 7);

    if (totalCustomers) totalCustomers.textContent = list.length;
    
    if (monthCustomers) {
        monthCustomers.textContent = list.filter(v => {
            const norm = normalizeDateString(v.creationDate || v.date || '');
            return norm.startsWith(currentYearMonth);
        }).length;
    }
    
    if (todayCustomers) {
        todayCustomers.textContent = list.filter(v => {
            const raw = String(v.creationDate || v.date || '').trim();
            const norm = normalizeDateString(raw);
            return norm === todayISO || raw === todayDisplay || raw === todayISO;
        }).length;
    }
}

async function updateCustomerOwner(code, newOwner) {
    newOwner = String(newOwner || '').trim();
    const customer = customersDataList.find(c => c.code === code);
    if (!customer) return;
    const oldOwner = String(customer.owner || '').trim();
    if (oldOwner === newOwner) return;

    customer.owner = newOwner;
    saveLocalBackup();

    const ownerMenu = document.getElementById('ownerFilterMenu');
    const prevChecked = new Set();
    if (ownerMenu) {
        ownerMenu.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]:checked').forEach(cb => prevChecked.add(cb.value));
        if (newOwner) prevChecked.add(newOwner);
        const allCbs = ownerMenu.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]');
        if (prevChecked.size === 0 || prevChecked.size === allCbs.length) {
            prevChecked.clear();
        }
    }

    populateFilterOptions();

    if (ownerMenu && prevChecked.size > 0) {
        const cbs = ownerMenu.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]');
        cbs.forEach(cb => {
            if (prevChecked.has(cb.value)) cb.checked = true;
        });
        updateFilters();
    }

    try {
        if (db) {
            await updateDoc(doc(db, "customers", code), { owner: newOwner });
        }
        await addToActivityLog('المستخدم', oldOwner, newOwner, customer.comp || code, newOwner || oldOwner || 'المستخدم');

        const inputEl = document.querySelector(`.owner-inline-input[data-code="${CSS.escape ? CSS.escape(code) : code}"]`);
        if (inputEl) {
            inputEl.classList.add('edited');
            inputEl.removeAttribute('title');
            setTimeout(() => inputEl.classList.remove('edited'), 1200);
        }
    } catch (e) {
        console.error("Error updating owner:", e);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء حفظ اسم المندوب', 'error');
        customer.owner = oldOwner;
        saveLocalBackup();
        filterAndRenderCustomers();
    }
}

function debouncedFilterTable() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        filterAndRenderCustomers();
    }, 250);
}

function openAddCustomerModal() {
    const modal = document.getElementById('addCustomerModal');
    if (modal) modal.style.display = 'flex';
    
    let nextNum = 1;
    const validCodes = customersDataList
        .map(c => {
            const match = String(c.code || '').match(/\d+/);
            return match ? parseInt(match[0], 10) : 0;
        })
        .filter(n => !isNaN(n) && isFinite(n));

    if (validCodes.length > 0) {
        nextNum = Math.max(...validCodes) + 1;
    }
    
    const addCodeInput = document.getElementById('addCode');
    if (addCodeInput) addCodeInput.value = 'CUST-' + String(nextNum).padStart(5, '0');
    
    const todayNorm = getTodayFormatted();
    const addDateInput = document.getElementById('addDate');
    if (addDateInput) addDateInput.value = todayNorm;
    
    ['addComp', 'addCity', 'addAddress', 'addCR', 'addManager', 'addMob', 'addEmail', 'addCreator'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

function closeAddCustomerModal() {
    const modal = document.getElementById('addCustomerModal');
    if (modal) modal.style.display = 'none';
}

async function saveNewCustomer() {
    const compEl = document.getElementById('addComp');
    const comp = compEl ? compEl.value.trim() : '';
    
    if (!comp) {
        SafeSwal.fire('تنبيه', 'يرجى إدخال اسم الشركة', 'warning');
        return;
    }

    const codeVal = document.getElementById('addCode')?.value || ('CUST-' + Date.now());
    const dateVal = document.getElementById('addDate')?.value || getTodayFormatted();
    const mgrVal = document.getElementById('addManager')?.value || '';
    const mobVal = document.getElementById('addMob')?.value || '';
    const emailVal = document.getElementById('addEmail')?.value || '';
    const creator = document.getElementById('addCreator')?.value || 'المستخدم';

    const crVal = document.getElementById('addCR')?.value || '';

    let allExisting = customersDataList || [];
    try {
        const localCusts = JSON.parse(localStorage.getItem('crm_customers') || '[]');
        if (Array.isArray(localCusts)) {
            const map = new Map();
            allExisting.forEach(c => { if (c.code) map.set(c.code, c); });
            localCusts.forEach(c => { if (c.code && !map.has(c.code)) map.set(c.code, c); });
            allExisting = Array.from(map.values());
        }
    } catch(e){}

    // التحقق الصارم من تكرار السجل التجاري ورفض النظام فوراً
    const crCheck = checkCustomerCrDuplicate({
        cr: crVal,
        existingCustomers: allExisting
    });

    if (crCheck.isDuplicate) {
        SafeSwal.fire({
            icon: 'warning',
            title: 'العميل مسجل سابقا',
            text: crCheck.message || 'العميل مسجل سابقا برقم السجل التجاري المدخل.',
            confirmButtonText: 'حسناً',
            confirmButtonColor: '#2563eb'
        });
        return;
    }

    const newCust = {
        code: codeVal, 
        date: dateVal, 
        creationDate: dateVal,
        comp: comp, 
        city: document.getElementById('addCity')?.value || '',
        address: document.getElementById('addAddress')?.value || '',
        cr: crVal,
        cr1: crVal,
        mgr: mgrVal, 
        mob: mobVal, 
        email: emailVal, 
        owner: creator,
        status: 'نشط', 
        classification: 'جديد', 
        lastActivityDate: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        notesText: '',
        managers: (mgrVal || mobVal || emailVal) ? [{
            id: Date.now(), name: mgrVal, phone: mobVal, altPhone: "",
            email: emailVal, jobTitle: "المدير / المسؤول", date: dateVal, isPrimary: true
        }] : [], 
        orders: [], visits: [], opportunities: [], sales: [], attachments: [], notesHistory: []
    };

    try {
        customersDataList.unshift(newCust);
        saveLocalBackup();
        updateStats(customersDataList);
        populateFilterOptions();
        await addToActivityLog('إجراء', 'إنشاء عميل جديد', '', newCust.comp, creator);

        if (db) {
            await setDoc(doc(db, "customers", newCust.code), newCust);
        }

        closeAddCustomerModal();
        SafeSwal.fire('نجاح', 'تم إضافة العميل بنجاح', 'success');
    } catch (error) {
        console.error("Error adding customer: ", error);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء حفظ البيانات', 'error');
    }
}

let currentNoteCode = null;

function openCustomerDetails(code) {
    if (!code) return;
    try { localStorage.setItem('last_customer_code', code); } catch(e){}
    window.location.href = `customer-details.html?code=${encodeURIComponent(code)}`;
}

function parseCustNoteDateTime(dateStr, timeStr) {
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

function openNote(code) {
    currentNoteCode = code;
    const modal = document.getElementById('noteModal');
    if (modal) modal.style.display = 'flex';
    
    const txtArea = document.getElementById('modalTextArea');
    if (txtArea) { txtArea.value = ''; txtArea.focus(); }
    
    const customer = customersDataList.find(c => c.code === code);
    const historyLog = document.getElementById('historyLog');
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    if (historyLog) {
        if (customer && (!customer.notesHistory || customer.notesHistory.length === 0) && customer.notesText && String(customer.notesText).trim() !== '') {
            customer.notesHistory = [{
                user: (customer.owner && customer.owner !== 'المستخدم') ? customer.owner : 'أحمد',
                date: customer.creationDate || customer.date || getTodayFormatted(),
                time: '09:00',
                text: String(customer.notesText).trim(),
                timestamp: Date.now()
            }];
        }

        if (customer && customer.notesHistory && customer.notesHistory.length) {
            historyLog.innerHTML = customer.notesHistory.map((msg, index) => {
                let msgDateObj = parseCustNoteDateTime(msg.date, msg.time);
                let dayStr = isNaN(msgDateObj.getTime()) ? '' : days[msgDateObj.getDay()] + ' ';
                let userName = msg.user && msg.user !== "المستخدم" ? msg.user : "أحمد";

                return `
                <div class="note-item">
                    <div class="note-header">
                        <span class="note-meta">
                            <span class="note-user"><i class="fas fa-user-circle"></i> ${escapeHTML(userName)}</span>
                            <span dir="ltr"><i class="far fa-calendar-alt"></i> ${escapeHTML(dayStr)} ${escapeHTML(msg.date || '')}</span>
                            <span dir="ltr"><i class="far fa-clock"></i> ${escapeHTML(msg.time || '')}</span>
                        </span>
                        <i class="fas fa-trash-alt delete-note-btn" onclick="window.deleteNote(${index})" title="حذف الملاحظة"></i>
                    </div>
                    <div class="note-body">${escapeHTML(msg.text || '')}</div>
                </div>`;
            }).join('');
            historyLog.scrollTop = historyLog.scrollHeight;
        } else {
            historyLog.innerHTML = '<div style="color:#64748b; text-align:center; font-size:11px; padding:20px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
        }
    }
}

function closeNote() {
    const modal = document.getElementById('noteModal');
    if (modal) modal.style.display = 'none';
    currentNoteCode = null;
}

async function saveNote() {
    if (!currentNoteCode) return;
    const txtArea = document.getElementById('modalTextArea');
    const text = txtArea ? txtArea.value.trim() : '';
    if (!text) { closeNote(); return; }

    const customer = customersDataList.find(c => c.code === currentNoteCode);
    if (!customer) return;
    
    let username = (customer.owner && customer.owner.trim() && customer.owner.trim() !== "المستخدم") ? customer.owner.trim() : "أحمد";
    if (!customer.notesHistory) customer.notesHistory = [];
    
    const nowIso = new Date().toISOString();
    customer.notesHistory.push({ user: username, date: getTodayFormatted(), time: getTimeFormatted(), text: text, timestamp: Date.now() });
    customer.notesText = text;
    customer.lastActivityDate = nowIso;
    customer.updatedAt = nowIso;
    if (customer.status === 'غير نشط' && customer.autoDeactivated) {
        customer.status = 'نشط';
        delete customer.autoDeactivated;
    }
    
    const targetCode = currentNoteCode;
    saveLocalBackup();
    closeNote();
    filterAndRenderCustomers();

    try {
        await addToActivityLog('إجراء', 'إضافة ملاحظة جديدة', '', customer.comp, username);
        if (db) {
            await setDoc(doc(db, "customers", targetCode), { 
                notesHistory: customer.notesHistory, 
                notesText: customer.notesText,
                lastActivityDate: nowIso,
                updatedAt: nowIso,
                status: customer.status
            }, { merge: true });
        }
    } catch (error) {
        console.error("Error updating note: ", error);
    }
}

async function deleteNote(index) {
    if (!currentNoteCode) return;
    const result = await SafeSwal.fire({
        title: 'تأكيد الحذف؟', text: "هل أنت متأكد من حذف هذه الملاحظة؟",
        icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444',
        cancelButtonColor: '#94a3b8', confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء'
    });

    if (result.isConfirmed) {
        const customer = customersDataList.find(c => c.code === currentNoteCode);
        if (!customer || !customer.notesHistory) return;
        
        customer.notesHistory.splice(index, 1);
        customer.notesText = customer.notesHistory.length > 0 ? customer.notesHistory[customer.notesHistory.length - 1].text : '';

        saveLocalBackup();
        openNote(currentNoteCode);
        filterAndRenderCustomers();

        try {
            await addToActivityLog('إجراء', 'تم حذف ملاحظة', '', customer.comp, customer.owner || "أحمد");
            if (db) {
                await setDoc(doc(db, "customers", currentNoteCode), {
                    notesHistory: customer.notesHistory,
                    notesText: customer.notesText,
                    updatedAt: new Date().toISOString()
                }, { merge: true });
            }
        } catch (error) {
            console.error("Error deleting note: ", error);
        }
    }
}

function toggleLogExpansion() {
    const section = document.getElementById('activityLogSection');
    const btn = document.getElementById('toggleExpandBtn');
    if (section) {
        section.classList.toggle('expanded');
        if (btn) {
            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = section.classList.contains('expanded') ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
            }
        }
    }
}

function toggleDropdown(event, btn) {
    event.stopPropagation();
    const menu = btn.nextElementSibling;
    if (menu) menu.classList.toggle('show');
}

function exportSelectedToExcel(selectedCodes) {
    let dataToExport = [];
    if (selectedCodes && selectedCodes.length > 0) {
        dataToExport = customersDataList.filter(c => selectedCodes.includes(c.code));
    } else {
        const visibleCodes = Array.from(document.querySelectorAll('#tableBody tr.main-row .select-check'))
            .filter(cb => {
                const tr = cb.closest('tr');
                return isRowVisible(tr);
            })
            .map(cb => cb.getAttribute('data-code'))
            .filter(Boolean);

        dataToExport = customersDataList.filter(c => visibleCodes.includes(c.code));
    }

    if (dataToExport.length === 0) {
        SafeSwal.fire('تنبيه', 'لا توجد بيانات لتصديرها', 'warning');
        return;
    }

    const exportData = dataToExport.map(c => ({
        "كود العميل": c.code,
        "اسم الشركة": c.comp || '',
        "المدينة": c.city || '',
        "اسم المسؤول": getDisplayManager(c) || '',
        "رقم التواصل": getDisplayMobile(c) || '',
        "البريد الإلكتروني": getDisplayEmail(c) || '',
        "السجل التجاري": c.cr || c.cr1 || '',
        "تاريخ الانشاء": formatDateDisplay(c.creationDate || c.date || ''),
        "تصنيف العميل": c.classification || c.source || '',
        "الملاحظات": c.notesText || '',
        "حالة العميل": c.status || 'جديد',
        "المستخدم": c.owner || 'المستخدم'
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "العملاء");
    XLSX.writeFile(workbook, `Customers_Export_${getTodayFormatted()}.xlsx`);
}

async function changeBulkUser(selectedCodes) {
    const { value: newUser } = await SafeSwal.fire({
        title: 'تغيير المستخدم',
        input: 'text',
        inputLabel: 'أدخل اسم المستخدم الجديد للعملاء المحددين (الظاهرين)',
        inputPlaceholder: 'الاسم...',
        showCancelButton: true,
        confirmButtonText: 'حفظ',
        cancelButtonText: 'إلغاء'
    });

    if (newUser && newUser.trim() !== '') {
        try {
            if (db) {
                const BATCH_SIZE = 400;
                for (let i = 0; i < selectedCodes.length; i += BATCH_SIZE) {
                    const chunk = selectedCodes.slice(i, i + BATCH_SIZE);
                    const batch = writeBatch(db);
                    chunk.forEach(code => {
                        const docRef = doc(db, "customers", code);
                        batch.update(docRef, { owner: newUser.trim() });
                    });
                    await batch.commit();
                }
            }

            selectedCodes.forEach(code => {
                const cust = customersDataList.find(c => c.code === code);
                if (cust) {
                    const oldUser = cust.owner;
                    cust.owner = newUser.trim();
                    addToActivityLog('المستخدم', oldUser, newUser.trim(), cust.comp, newUser.trim());
                }
            });

            saveLocalBackup();
            populateFilterOptions();
            SafeSwal.fire('نجاح', 'تم تغيير المستخدم بنجاح للعملاء المحددين', 'success');
        } catch (e) {
            console.error("Error updating users: ", e);
            SafeSwal.fire('خطأ', 'حدث خطأ أثناء تحديث المستخدم', 'error');
        }
    }
}

async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    
    const selectedCodes = getSelectedVisibleCodes();

    if (action === 'استيراد' || action === 'استيراد من Excel') {
        const fileInp = document.getElementById('excelUpload');
        if (fileInp) fileInp.click();
        return;
    }

    if (selectedCodes.length === 0 && (action === 'حذف' || action === 'حذف المحدد' || action === 'تغيير المستخدم')) {
        SafeSwal.fire('تنبيه', 'يرجى تحديد عميل واحد على الأقل من الصفوف الظاهرة لتنفيذ الإجراء', 'warning');
        return;
    }

    if (action === 'تصدير' || action === 'تصدير إلى Excel') {
        exportSelectedToExcel(selectedCodes);
    } else if (action === 'تغيير المستخدم') {
        changeBulkUser(selectedCodes);
    } else if (action === 'طباعة') {
        window.print();
    } else if (action === 'حذف' || action === 'حذف المحدد') {
        const result = await SafeSwal.fire({
            title: 'تأكيد الحذف الجماعي؟', 
            text: `هل أنت متأكد من حذف ${selectedCodes.length} عميل محدد من الظاهرين فقط؟`,
            icon: 'warning', 
            showCancelButton: true, 
            confirmButtonColor: '#ef4444', 
            cancelButtonColor: '#94a3b8', 
            confirmButtonText: 'نعم، احذف', 
            cancelButtonText: 'إلغاء'
        });

        if (result.isConfirmed) {
            try {
                if (db) {
                    const BATCH_SIZE = 400;
                    for (let i = 0; i < selectedCodes.length; i += BATCH_SIZE) {
                        const chunk = selectedCodes.slice(i, i + BATCH_SIZE);
                        const batch = writeBatch(db);
                        chunk.forEach(code => {
                            const docRef = doc(db, "customers", code);
                            batch.delete(docRef);
                        });
                        await batch.commit();
                    }
                }

                for (const code of selectedCodes) {
                    const cust = customersDataList.find(c => c.code === code);
                    if (cust) {
                        await addToActivityLog('إجراء', 'حذف عميل جماعي', '', cust.comp, cust.owner || "المستخدم");
                    }
                }

                customersDataList = customersDataList.filter(c => !selectedCodes.includes(c.code));
                saveLocalBackup();
                updateStats(customersDataList);
                populateFilterOptions();
                
                SafeSwal.fire('تم الحذف!', 'تم حذف العملاء المحددين بنجاح.', 'success');
            } catch (e) {
                console.error("Error in bulk delete: ", e);
                SafeSwal.fire('خطأ', 'حدث خطأ أثناء الحذف الجماعي', 'error');
            }
        }
    }
}

function parseExcelSerialDate(val) {
    if (!val) return getTodayFormatted();
    if (typeof val === 'number' || (/^\d{5}$/.test(String(val).trim()) && !String(val).includes('-'))) {
        const utcDays = Math.floor(Number(val) - 25569);
        const d = new Date(utcDays * 86400 * 1000);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
    return normalizeDateString(val);
}

async function handleExcelUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

            if (rows.length === 0) {
                SafeSwal.fire('تنبيه', 'الملف فارغ!', 'warning');
                return;
            }

            SafeSwal.fire({ title: 'جاري الاستيراد والتحقق من السجلات...', allowOutsideClick: false, didOpen: () => { if (typeof window.Swal !== 'undefined') window.Swal.showLoading(); }});

            let nextNum = 1;
            const validCodes = customersDataList
                .map(c => {
                    const match = String(c.code || '').match(/\d+/);
                    return match ? parseInt(match[0], 10) : 0;
                })
                .filter(n => !isNaN(n) && isFinite(n));

            if (validCodes.length > 0) {
                nextNum = Math.max(...validCodes) + 1;
            }

            const newImportedData = [];
            const skippedDuplicates = [];
            const currentDate = getTodayFormatted();
            const currentTime = getTimeFormatted();

            // فحص كل سطر مستورد ومنع تكرار أي سجل رئيسي أو فرعي مسبق التسجيل
            const existingPool = [...customersDataList];

            for (const row of rows) {
                const rowCr = row['السجل التجاري'] || row['السجل'] || row['السجل الرئيسي'] || row['سجل رئيسي'] || '';
                const compName = row['اسم الشركة'] || row['الشركة'] || 'عميل مستورد';

                const crCheck = checkCustomerCrDuplicate({
                    cr: rowCr,
                    existingCustomers: existingPool
                });

                if (crCheck.isDuplicate) {
                    skippedDuplicates.push({ comp: compName, cr: crCheck.matchedCr, reason: crCheck.message });
                    continue; // Skip duplicate customer
                }

                let currentCode = row['كود العميل'] || ('CUST-' + String(nextNum++).padStart(5, '0'));
                let noteText = String(row['الملاحظات'] || "").trim();
                let notesHistoryArr = [];
                
                if (noteText) {
                    notesHistoryArr.push({
                        user: "استيراد إكسيل",
                        date: currentDate,
                        time: currentTime,
                        text: noteText
                    });
                }

                const rawDate = row['تاريخ الانشاء'] || row['التاريخ'] || currentDate;
                const normalizedDate = parseExcelSerialDate(rawDate);

                let newCust = {
                    code: String(currentCode).trim(),
                    comp: compName,
                    city: row['المدينة'] || '',
                    address: row['العنوان'] || '',
                    mgr: row['اسم المسؤول'] || '',
                    mob: row['رقم التواصل'] || '',
                    email: row['البريد الإلكتروني'] || '',
                    cr: rowCr,
                    cr1: rowCr,
                    date: normalizedDate,
                    creationDate: normalizedDate,
                    classification: row['تصنيف العميل'] || 'جديد',
                    status: row['حالة العميل'] || 'نشط',
                    owner: row['المستخدم'] || row['المالك'] || 'المستخدم',
                    notesText: noteText,
                    notesHistory: notesHistoryArr,
                    orders: [], visits: [], opportunities: [], sales: [], attachments: [], managers: []
                };

                newImportedData.push(newCust);
                existingPool.push(newCust);
            }

            if (newImportedData.length === 0 && skippedDuplicates.length > 0) {
                SafeSwal.fire({
                    icon: 'warning',
                    title: 'العميل مسجل سابقا',
                    html: `لم يتم استيراد أي عميل لأن جميع سجلات الإكسيل مسجلة مسبقاً في النظام.<br><small style="color:#ef4444">${skippedDuplicates.map(s => escapeHTML(s.comp + ': ' + s.cr)).slice(0, 5).join('<br>')}</small>`
                });
                event.target.value = '';
                return;
            }

            if (db && newImportedData.length > 0) {
                const BATCH_SIZE = 400;
                for (let i = 0; i < newImportedData.length; i += BATCH_SIZE) {
                    const chunk = newImportedData.slice(i, i + BATCH_SIZE);
                    const batch = writeBatch(db);
                    chunk.forEach(cust => {
                        const docRef = doc(db, "customers", cust.code);
                        batch.set(docRef, cust);
                    });
                    await batch.commit();
                }
            }

            customersDataList = [...newImportedData, ...customersDataList];
            saveLocalBackup();
            updateStats(customersDataList);
            populateFilterOptions();
            
            await addToActivityLog('إجراء', `استيراد ${newImportedData.length} عميل جديد`, '', 'العملاء', 'استيراد إكسيل');

            let msg = `تم استيراد ${newImportedData.length} عميل بنجاح.`;
            if (skippedDuplicates.length > 0) {
                msg += `<br><span style="color:#f59e0b;font-size:11px;">تم تخطي ${skippedDuplicates.length} عميل لأن سجلاتهم مسجلة سابقاً في النظام.</span>`;
            }
            SafeSwal.fire({
                icon: 'success',
                title: 'اكتمل الاستيراد',
                html: msg
            });
            event.target.value = '';
        } catch (error) {
            console.error("Import Error: ", error);
            SafeSwal.fire('خطأ', 'حدثت مشكلة أثناء قراءة الملف أو الرفع', 'error');
        }
    };
    reader.readAsArrayBuffer(file);
}

document.addEventListener('change', (e) => {
    if (e.target && e.target.classList.contains('select-check')) {
        updateMasterCheckboxState();
    }
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.multi-select-menu.show').forEach(m => {
            m.classList.remove('show');
            const w = m.closest('.custom-filter-wrapper');
            if (w) w.classList.remove('active');
        });
    }
    if (!e.target.closest('.bulk-action-wrapper')) {
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    }
});

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
    btn.removeAttribute('title');
    localStorage.setItem('asgate_customers_stats_hidden', isHidden ? 'true' : 'false');
}

function initStatsVisibility() {
    const isHidden = localStorage.getItem('asgate_customers_stats_hidden') === 'true';
    const container = document.getElementById('statsContainer');
    const btn = document.getElementById('eyeToggleBtn');
    if (!container || !btn) return;
    if (isHidden) {
        container.classList.add('blur-active');
        btn.innerHTML = getEyeHideIconSvg(20);
    } else {
        btn.innerHTML = getEyeShowIconSvg(20);
    }
    btn.removeAttribute('title');
}

window.toggleCustomFilter = toggleCustomFilter;
window.selectAllFilter = selectAllFilter;
window.clearAllFilter = clearAllFilter;
window.updateFilters = updateFilters;
window.deleteNote = deleteNote;
window.openAddCustomerModal = openAddCustomerModal;
window.closeAddCustomerModal = closeAddCustomerModal;
window.saveNewCustomer = saveNewCustomer;
window.openNote = openNote;
window.openCustomerDetails = openCustomerDetails;
window.updateCustomerOwner = updateCustomerOwner;
window.closeNote = closeNote;
window.saveNote = saveNote;
window.debouncedFilterTable = debouncedFilterTable;
window.toggleLogExpansion = toggleLogExpansion;
window.toggleDropdown = toggleDropdown;
window.toggleAllCheckboxes = toggleAllCheckboxes;
window.handleBulkAction = handleBulkAction;
window.handleExcelUpload = handleExcelUpload;
window.updateMasterCheckboxState = updateMasterCheckboxState;
window.toggleStatsVisibility = toggleStatsVisibility;
window.initStatsVisibility = initStatsVisibility;
window.getEyeHideIconSvg = getEyeHideIconSvg;
window.getEyeShowIconSvg = getEyeShowIconSvg;

function checkUrlHighlight() {
    const urlParams = new URLSearchParams(window.location.search);
    const highlightId = urlParams.get('highlight');
    if (highlightId) {
        setTimeout(() => {
            if (typeof window.triggerElementHighlight === 'function') {
                window.triggerElementHighlight(highlightId);
            }
        }, 500);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initDomReferences();
    loadSavedData();
    initStatsVisibility();
    checkUrlHighlight();
});
