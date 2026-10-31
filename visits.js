// =========================================================================
// visits.js - إدارة الزيارات سحابياً ومحلياً (نظام ASGate CRM)
// استراتيجية ترشيد الكوتا (Zero-Waste Firebase Quota):
// 1. قراءة فورية من الكاش المحلي (asgate_visits_local_cache_v1) فور فتح الصفحة
// 2. تحديث الكاش المحلي فورياً مع تأخير (Debounce) الكتابة السحابية
// 3. استخدام writeBatch في الحذف والاستيراد ونقل الزيارات للفرص
// 4. حماية خلايا التحرير النشطة من التحديث الفجائي
// =========================================================================

import Swal from 'sweetalert2';
import * as XLSX from 'xlsx';
window.Swal = Swal;
window.XLSX = XLSX;

import { db, collection, onSnapshot, doc, setDoc, deleteDoc, getDocs, writeBatch } from './firebase-config.js';
import { isCustomerMatchedByCr, createActivityLogEntry, renderActivityLogsHTML } from './src/crm_logic.js';

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

function markPageReady() {
    const container = document.getElementById('dashboardContainer') || document.querySelector('.dashboard-container');
    if (container) {
        container.classList.add('ready');
        container.style.opacity = '1';
    }
}

let currentActivePreview = null;
const saveTimeouts = {}; 
let searchTimeout = null;
const LOGS_KEY = 'asgate_visits_logs_v1';
const VISITS_LOCAL_KEY = 'asgate_visits_local_cache_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

let visitsDataArray = [];
let isInitialLoad = true;
let activityLogs = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');

let currentPickerRowId = null;
let currentPickerInput = null;
let currentPickerMonth = new Date().getMonth();
let currentPickerYear = new Date().getFullYear();

let activeStatusFilters = ['تأهيل لفرصة', 'مميزة', 'متابعة', 'عرض سعر', 'زيارة', 'اتصال', 'غير مهتم', 'فقدان'];
let totalStatusOptionsCount = 8;
let userHasExplicitlyFilteredStatus = false;

let activeOwnerFilters = [];
let totalOwnerOptionsCount = 0;
let userHasExplicitlyFilteredOwner = false;
let isOwnerFilterInitialized = false;

let itemsToDelete = [];
let isInsertingRow = false;

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function toEnglishDigits(val) {
    if (val === null || val === undefined || val === '') return '';
    let str = String(val);
    str = str.replace(/[\u0660-\u0669]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 48));
    str = str.replace(/[\u06F0-\u06F9]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 48));
    return str;
}

function fromArabicDigits(val) {
    return toEnglishDigits(val);
}

function formatEnglishNumber(num) {
    if (num === null || num === undefined || num === '') return '0';
    const cleanStr = toEnglishDigits(String(num)).replace(/,/g, '').trim();
    const n = Number(cleanStr) || 0;
    return n.toLocaleString('en-US');
}

function enforceEnglishDigitsInDOM() {
    try {
        const inputs = document.querySelectorAll('#mainTable input, .custom-datepicker input, .custom-datepicker select, .inner-table input');
        inputs.forEach(input => {
            if (input.value && /[\u0660-\u0669\u06F0-\u06F9]/.test(input.value)) {
                input.value = toEnglishDigits(input.value);
            }
        });
        const textNodes = document.querySelectorAll('.stat-val, .day-number, .sep-text, .edit-date-d, .log-header-info span, .note-meta span');
        textNodes.forEach(el => {
            if (el.textContent && /[\u0660-\u0669\u06F0-\u06F9]/.test(el.textContent)) {
                el.textContent = toEnglishDigits(el.textContent);
            }
        });
    } catch(e) {}
}

function normalizeVisitData(v) {
    if (!v) return v;
    if (v.mob) v.mob = toEnglishDigits(v.mob).replace(/[^0-9]/g, '');
    if (v.record) v.record = toEnglishDigits(v.record).replace(/[^0-9]/g, '');
    if (v.visitDate) v.visitDate = formatAsDDMMYYYY(toEnglishDigits(v.visitDate));
    if (v.editDate) v.editDate = toEnglishDigits(v.editDate);
    if (v.oppValue !== undefined) v.oppValue = String(toEnglishDigits(v.oppValue));
    if (Array.isArray(v.products)) {
        v.products.forEach(p => {
            if (p) {
                if (p.name) p.name = toEnglishDigits(p.name);
                if (p.qty !== undefined) p.qty = Number(toEnglishDigits(p.qty)) || 1;
                if (p.price !== undefined) p.price = Number(toEnglishDigits(p.price)) || 0;
                if (p.total !== undefined) p.total = Number(toEnglishDigits(p.total)) || (p.qty * p.price);
            }
        });
    }
    return v;
}

function getTodayFormatted() { 
    const d = new Date(); 
    return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear(); 
}

function getTimeFormatted() { 
    const d = new Date(); 
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0'); 
}

function formatAsDDMMYYYY(dateStr) {
    if (!dateStr) return '';
    let num = NaN;
    const cleanStr = fromArabicDigits(String(dateStr).trim());
    if (typeof dateStr === 'number') {
        num = dateStr;
    } else if (/^\d+(\.\d+)?$/.test(cleanStr)) {
        num = parseFloat(cleanStr);
    }
    
    if (!isNaN(num) && num > 10000 && num < 100000) {
        const utcDays = Math.floor(num - 25569);
        const d = new Date(utcDays * 86400 * 1000);
        return String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + d.getUTCFullYear();
    }

    let dStr = cleanStr.split(' ')[0].split('T')[0];
    if (dStr.includes('-')) {
        const p = dStr.split('-');
        if (p[0].length === 4) return `${String(p[2]).padStart(2,'0')}-${String(p[1]).padStart(2,'0')}-${p[0]}`; 
        if (p.length === 3) return `${String(p[0]).padStart(2,'0')}-${String(p[1]).padStart(2,'0')}-${p[2]}`;
    } else if (dStr.includes('/')) {
        const p = dStr.split('/');
        if (p[0].length === 4) return `${String(p[2]).padStart(2,'0')}-${String(p[1]).padStart(2,'0')}-${p[0]}`;
        if (p.length === 3) return `${String(p[0]).padStart(2,'0')}-${String(p[1]).padStart(2,'0')}-${p[2]}`;
    }
    return dStr;
}

function parseDate(dateStr) {
    if (!dateStr) return new Date(0);
    const cleaned = fromArabicDigits(String(dateStr)).trim().replace(/\//g, '-').split(' ')[0].split('T')[0];
    const parts = cleaned.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)); 
        return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10)); 
    }
    return new Date(0);
}

function getVisitTimestamp(v) {
    if (!v) return 0;
    if (typeof v.createdAt === 'number' && !isNaN(v.createdAt)) return v.createdAt;
    if (v.createdAt && !isNaN(Number(v.createdAt))) return Number(v.createdAt);
    if (typeof v.id === 'string') {
        const m = v.id.match(/(\d+)/);
        if (m) {
            return parseInt(m[1], 10);
        }
    }
    return 0;
}

function getDaysSinceDate(dateStr) {
    if (!dateStr) return 0;
    const d = parseDate(dateStr);
    if (!d || isNaN(d.getTime()) || d.getTime() === 0) return 0;
    const now = new Date();
    const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const diffMs = nowMidnight - dMidnight;
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function parseEditDateHTML(editDateStr, fallbackDateStr = '') {
    const raw = editDateStr || fallbackDateStr;
    if (!raw) return `<span class="edit-date-d">-</span>`;
    let dateOnly = String(raw).trim().split(' ')[0].split('T')[0];
    const days = getDaysSinceDate(dateOnly);
    let extraClass = '';
    let customColor = '';
    let titleAttr = '';
    
    if (days > 30) {
        extraClass = ' edit-danger-30';
        customColor = 'color: #C00000 !important;';
        titleAttr = `title="لم يتم إجراء أي تعديل على الزيارة منذ ${days} يوم (تجاوز 30 يوم)"`;
    } else if (days > 10) {
        extraClass = ' edit-warn-10';
        customColor = 'color: #FFC000 !important;';
        titleAttr = `title="آخر تعديل: منذ ${days} يوم (بين 10 إلى 30 يوم دون تحديث)"`;
    } else {
        extraClass = ' edit-active-10';
        customColor = 'color: #00B050 !important;';
        titleAttr = `title="آخر تعديل: ${days === 0 ? 'اليوم' : 'منذ ' + days + ' أيام'} (أقل من 10 أيام)"`;
    }
    
    const formattedText = formatAsDDMMYYYY(dateOnly) || dateOnly;
    const styleAttr = `style="${customColor} font-weight: 800;"`;
    return `<span class="edit-date-d${extraClass}" ${styleAttr}>${escapeHTML(toEnglishDigits(formattedText))}</span>`;
}

function updateEditDateField(tr) {
    if (!tr) return;
    const today = getTodayFormatted();
    const hiddenInput = tr.querySelector('.edit-date-val');
    if (hiddenInput) hiddenInput.value = today;
    const containerMain = tr.querySelector('.edit-date-container-main');
    if (containerMain) containerMain.innerHTML = parseEditDateHTML(today);
}

function sanitizeMobileInput(inputEl, rowId) {
    if (!inputEl) return;
    const cleanedDigits = toEnglishDigits(inputEl.value).replace(/\D/g, '');
    if (inputEl.value !== cleanedDigits) {
        inputEl.value = cleanedDigits;
    }
    
    const mainRow = inputEl.closest('tr.main-row');
    if (mainRow) {
        const waBtn = mainRow.querySelector('.whatsapp-icon-btn');
        if (waBtn) {
            const waClean = cleanPhone(cleanedDigits);
            if (waClean) {
                waBtn.href = `https://wa.me/${waClean}`;
                waBtn.style.display = 'inline-flex';
            } else {
                waBtn.style.display = 'none';
            }
        }
    }
    
    if (rowId) {
        debouncedSaveRow(rowId);
    }
}

function handleMobilePaste(event, inputEl, rowId) {
    event.preventDefault();
    const clipboardData = event.clipboardData || window.clipboardData;
    const pastedText = clipboardData ? clipboardData.getData('text') : '';
    const cleanedDigits = toEnglishDigits(pastedText).replace(/\D/g, '');
    
    const start = inputEl.selectionStart || 0;
    const end = inputEl.selectionEnd || 0;
    const currentVal = inputEl.value || '';
    const newVal = currentVal.substring(0, start) + cleanedDigits + currentVal.substring(end);
    inputEl.value = toEnglishDigits(newVal).replace(/\D/g, '');
    
    const newPos = start + cleanedDigits.length;
    try {
        inputEl.setSelectionRange(newPos, newPos);
    } catch(e){}
    
    sanitizeMobileInput(inputEl, rowId);
}

function cleanPhone(phone) {
    if (!phone) return '';
    let cleaned = toEnglishDigits(String(phone)).replace(/\D/g, '');
    if (cleaned.startsWith('05')) {
        cleaned = '966' + cleaned.substring(1);
    }
    return cleaned;
}

function getLastNoteOnlyFromJSON(jsonStr) { 
    try { 
        const arr = JSON.parse(jsonStr || "[]"); 
        if (Array.isArray(arr) && arr.length > 0) {
            const last = arr[arr.length - 1];
            return last.text || last.note || "";
        }
        return "";
    } catch(e) { 
        if (typeof jsonStr === 'string' && jsonStr.trim() !== '' && jsonStr !== '[]') return jsonStr;
        return ""; 
    } 
}

function parseNoteDateTime(dateStr, timeStr) {
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

async function addToActivityLog(fieldName, oldVal, newVal, companyName, ownerName) {
    const logEntry = createActivityLogEntry({
        page: 'visits',
        fieldName,
        oldVal,
        newVal,
        identifierValue: companyName,
        user: ownerName
    });
    if (!logEntry) return;
    activityLogs.unshift(logEntry);
    activityLogs = activityLogs.slice(0, 100);
    try {
        localStorage.setItem(LOGS_KEY, JSON.stringify(activityLogs));
    } catch(e) {}
    renderActivityLogs();
    try {
        if (db) await setDoc(doc(db, "visits_activity_logs", logEntry.timestamp.toString()), logEntry);
    } catch(e) {}
}

function handleVisitFieldBlur(el, fieldName) {
    if (!el) return;
    const row = el.closest('tr');
    const comp = row?.querySelector('td.col-company input')?.value || '';
    const owner = row?.querySelector('.owner-input')?.value || '';
    const oldVal = el.dataset.old !== undefined ? el.dataset.old : '';
    const newVal = el.value || '';
    if (oldVal !== newVal) {
        addToActivityLog(fieldName, oldVal, newVal, comp, fieldName === 'المستخدم' ? newVal : owner);
        el.dataset.old = newVal;
    }
}

function renderActivityLogs() {
    const listEl = document.getElementById('activityList');
    if (!listEl) return;
    listEl.innerHTML = renderActivityLogsHTML(activityLogs, 'visits');
}

function toggleLogExpansion() {
    const sec = document.getElementById('activityLogSection');
    const btn = document.getElementById('toggleExpandBtn');
    if (!sec) return;
    sec.classList.toggle('expanded');
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = sec.classList.contains('expanded') ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
        }
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
    const masterCb = document.querySelector('thead th.col-select input[type="checkbox"], #masterCheckbox');
    if (!masterCb) return;

    const visibleRows = Array.from(document.querySelectorAll('#tableBody tr.main-row')).filter(isRowVisible);
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
    const rows = document.querySelectorAll('#tableBody tr.main-row');
    rows.forEach(row => {
        const chk = row.querySelector('.select-check');
        if (!chk) return;
        if (isRowVisible(row)) {
            chk.checked = isChecked;
        } else {
            chk.checked = false;
        }
    });
    updateMasterCheckboxState();
}

document.addEventListener('change', (e) => {
    if (e.target && e.target.classList.contains('select-check') && e.target.id !== 'masterCheckbox') {
        updateMasterCheckboxState();
    }
});

function openNote(el) {
    currentActivePreview = el;
    let arr = []; 
    try { arr = JSON.parse(el.getAttribute('data-full-notes') || "[]"); } catch(e) {}
    
    const historyLog = document.getElementById('historyLog');
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    if (historyLog) {
        historyLog.innerHTML = arr.map((msg, index) => {
            let msgDateObj = parseNoteDateTime(msg.date, msg.time);
            let dayStr = isNaN(msgDateObj.getTime()) ? '' : days[msgDateObj.getDay()] + ' ';
            let userName = msg.user && msg.user !== "المستخدم" ? msg.user : "أحمد";

            let showDelete = true;
            if (msg.date && msg.time) {
                let noteDateTime = parseNoteDateTime(msg.date, msg.time);
                if (!isNaN(noteDateTime.getTime())) {
                    let diffInHours = (new Date() - noteDateTime) / (1000 * 60 * 60);
                    if (diffInHours > 24) showDelete = false;
                }
            }
            
            let deleteBtnHtml = showDelete ? `<i class="fas fa-trash-alt delete-note-btn" onclick="deleteNote(${index})" title="حذف الملاحظة"></i>` : '';

            return `
            <div class="note-item">
                <div class="note-header">
                    <span class="note-meta">
                        <span class="note-user"><i class="fas fa-user-circle"></i> ${escapeHTML(userName)}</span>
                        <span dir="ltr"><i class="far fa-calendar-alt"></i> ${escapeHTML(dayStr)} ${escapeHTML(toEnglishDigits(msg.date || ''))}</span>
                        <span dir="ltr"><i class="far fa-clock"></i> ${escapeHTML(toEnglishDigits(msg.time || ''))}</span>
                    </span>
                    <i class="fas fa-trash-alt delete-note-btn" onclick="deleteNote(${index})" title="حذف الملاحظة"></i>
                </div>
                <div class="note-body">${escapeHTML(msg.text || '')}</div>
            </div>
            `;
        }).join('') || '<div style="color:#64748b; text-align:center; font-size:11px; padding:20px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
    }
    
    const noteModal = document.getElementById('noteModal');
    if (noteModal) { noteModal.style.display = "flex"; if (historyLog) historyLog.scrollTop = historyLog.scrollHeight; }
    
    const modalTextArea = document.getElementById('modalTextArea');
    if (modalTextArea) { modalTextArea.value = ""; modalTextArea.focus(); }
}

function saveNote() {
    const txt = document.getElementById('modalTextArea').value.trim();
    if (txt && currentActivePreview) {
        let arr = []; 
        try { arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || "[]"); } catch(e) {}
        
        let username = "أحمد"; 
        const mainRow = currentActivePreview.closest('.main-row');
        
        if (mainRow) { 
            const ownerInput = mainRow.querySelector('.owner-input'); 
            if (ownerInput && ownerInput.value.trim()) username = ownerInput.value.trim(); 
        }
        
        arr.push({ user: username, date: getTodayFormatted(), time: getTimeFormatted(), text: txt });
        const jsonStr = JSON.stringify(arr);
        currentActivePreview.setAttribute('data-full-notes', jsonStr); 
        currentActivePreview.innerText = txt;
        
        if (mainRow) { 
            const comp = mainRow.querySelector('td.col-company input')?.value || '';
            addToActivityLog('الملاحظات', '', txt, comp, username);
            updateEditDateField(mainRow); 
            saveSingleRow(mainRow.id); 
        }
    }
    closeNote();
}

async function deleteNote(index) {
    if (!currentActivePreview) return;
    const result = await SafeSwal.fire({
        title: 'تأكيد الحذف؟', text: "هل أنت متأكد من حذف هذه الملاحظة؟", icon: 'warning',
        showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#94a3b8',
        confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء'
    });

    if (result.isConfirmed) {
        let arr = [];
        try { arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || "[]"); } catch(e) {}
        const removedText = arr[index]?.text || '';
        arr.splice(index, 1);
        const jsonStr = JSON.stringify(arr);
        currentActivePreview.setAttribute('data-full-notes', jsonStr);
        currentActivePreview.innerText = getLastNoteOnlyFromJSON(jsonStr);

        const mainRow = currentActivePreview.closest('.main-row');
        if (mainRow) {
            const comp = mainRow.querySelector('td.col-company input')?.value || '';
            const owner = mainRow.querySelector('.owner-input')?.value || 'المستخدم';
            addToActivityLog('الملاحظات', removedText || 'ملاحظة', '', comp, owner);
            updateEditDateField(mainRow);
            saveSingleRow(mainRow.id);
        }
        openNote(currentActivePreview);
    }
}

function closeNote() { 
    const noteModal = document.getElementById('noteModal');
    if (noteModal) noteModal.style.display = "none"; 
}

async function insertNewRow() {
    if (isInsertingRow) return;
    isInsertingRow = true;

    try {
        const now = Date.now();
        const newId = 'visit_' + now;
        const today = getTodayFormatted();
        
        const newVisit = {
            id: newId,
            createdAt: now,
            comp: '', address: '', mgr: '', mob: '', email: '', record: '',
            visitDate: today, curServ: '', oppValue: '0', notes: '[]',
            status: '', editDate: today, owner: 'المستخدم', products: []
        };

        const existingIdx = visitsDataArray.findIndex(v => v.id === newId);
        if (existingIdx === -1) {
            visitsDataArray.unshift(newVisit);
        } else {
            visitsDataArray[existingIdx] = newVisit;
        }

        try {
            let localCache = JSON.parse(localStorage.getItem(VISITS_LOCAL_KEY) || '{}');
            localCache[newId] = newVisit;
            localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(localCache));
        } catch(e){}

        filterTable();

        setTimeout(() => {
            const firstRow = document.getElementById(newId);
            if (firstRow) {
                const compInput = firstRow.querySelector('td.col-company input');
                if (compInput) compInput.focus();
            }
        }, 50);

        if (db) {
            const currentObj = visitsDataArray.find(v => v.id === newId) || newVisit;
            await setDoc(doc(db, "visits", newId), currentObj);
        }
    } catch (error) {
        console.error("خطأ في إضافة زيارة جديدة سحابياً:", error);
    } finally {
        setTimeout(() => {
            isInsertingRow = false;
        }, 300);
    }
}

function listenToVisits() {
    renderActivityLogs();

    if (db) {
        try {
            onSnapshot(collection(db, "visits_activity_logs"), (logsSnap) => {
                if (!logsSnap.empty) {
                    const cloudLogs = [];
                    logsSnap.forEach((d) => cloudLogs.push(d.data()));
                    cloudLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                    activityLogs = cloudLogs.slice(0, 100);
                    try { localStorage.setItem(LOGS_KEY, JSON.stringify(activityLogs)); } catch(e) {}
                    renderActivityLogs();
                }
            }, (err) => {
                console.warn("ملاحظة مزامنة سجل نشاط الزيارات:", err);
            });
        } catch(e) {}
    }

    const statusCbs = document.querySelectorAll('#statusFilterMenu input[type="checkbox"]');
    if (statusCbs.length > 0) {
        totalStatusOptionsCount = statusCbs.length;
        activeStatusFilters = Array.from(statusCbs).filter(cb => cb.checked).map(cb => cb.value);
        if (activeStatusFilters.length === 0) {
            statusCbs.forEach(cb => cb.checked = true);
            activeStatusFilters = Array.from(statusCbs).map(cb => cb.value);
        }
    }

    try {
        const rawVisits = localStorage.getItem(VISITS_LOCAL_KEY);
        if (rawVisits) {
            const parsed = JSON.parse(rawVisits);
            const localArray = Array.isArray(parsed) ? parsed : Object.values(parsed);
            if (localArray.length > 0) {
                const seen = new Set();
                visitsDataArray = localArray.filter(v => {
                    if (!v || !v.id || seen.has(v.id)) return false;
                    seen.add(v.id);
                    normalizeVisitData(v);
                    if (!v.createdAt) v.createdAt = getVisitTimestamp(v);
                    return true;
                });
                updateDynamicOwnerFilter();
                updateStats();
                filterTable();
                markPageReady();
            }
        }
    } catch(e) {
        console.error("خطأ قراءة التخزين المحلي للزيارات:", e);
    }

    if (!visitsDataArray || visitsDataArray.length === 0) {
        visitsDataArray = [
            {
                id: "visit_26_001", createdAt: 1768416000000, comp: "شركة الأفق للحلول الرقمية", address: "الرياض - الصحافة", mgr: "فهد العتيبي",
                mob: "0501234567", email: "info@alofooq.sa", record: "1010345678", visitDate: "14-01-2026",
                curServ: "سنترال سحابي", oppValue: "5000", notes: "[]", status: "مميزة", editDate: "14-01-2026",
                owner: "أحمد الحربي", products: [{ name: "سنترال سحابي متطور", qty: 1, price: 5000 }]
            },
            {
                id: "visit_26_002", createdAt: 1768934400000, comp: "مستشفى الرعاية المتقدمة", address: "جدة - الحمراء", mgr: "د. طارق الغامدي",
                mob: "0552345678", email: "tariq@care.med", record: "4030112233", visitDate: "20-01-2026",
                curServ: "ربط فروع", oppValue: "12000", notes: "[]", status: "متابعة", editDate: "20-01-2026",
                owner: "محمد القحطاني", products: [{ name: "شبكة ربط فروع", qty: 2, price: 6000 }]
            },
            {
                id: "visit_26_003", createdAt: 1769625600000, comp: "وزارة الموارد البشرية", address: "الرياض - المعذر", mgr: "سلطان الدوسري",
                mob: "0543456789", email: "sdosari@hr.gov.sa", record: "7001234567", visitDate: "28-01-2026",
                curServ: "أمن سيبراني", oppValue: "25000", notes: "[]", status: "عرض سعر", editDate: "28-01-2026",
                owner: "أحمد الحربي", products: [{ name: "باقة حماية أمنية", qty: 1, price: 25000 }]
            },
            {
                id: "visit_26_004", createdAt: 1770230400000, comp: "مجموعة البناء الحديث", address: "الدمام - الشاطئ", mgr: "م. حسام الزهراني",
                mob: "0564567890", email: "husam@modernbuild.com", record: "2050987654", visitDate: "05-02-2026",
                curServ: "كاميرات مراقبة", oppValue: "0", notes: "[]", status: "غير مهتم", editDate: "05-02-2026",
                owner: "خالد الشمري", products: []
            },
            {
                id: "visit_26_005", createdAt: 1770835200000, comp: "مؤسسة الابتكار للتجارة", address: "المدينة - قباء", mgr: "صالح المولد",
                mob: "0575678901", email: "saleh@ebtekar.com", record: "4650334455", visitDate: "12-02-2026",
                curServ: "نقاط بيع", oppValue: "0", notes: "[]", status: "فقدان", editDate: "12-02-2026",
                owner: "سارة العتيبي", products: []
            },
            {
                id: "visit_26_006", createdAt: 1773177600000, comp: "شركة المدار المتطور للاتصالات", address: "الرياض - الملز", mgr: "عبدالله السالم",
                mob: "0509871234", email: "salem@almadar.sa", record: "1010887766", visitDate: "10-03-2026",
                curServ: "فايبر أعمال", oppValue: "18000", notes: "[]", status: "مميزة", editDate: "10-03-2026",
                owner: "أحمد الحربي", products: [{ name: "فايبر أعمال مخصص", qty: 1, price: 18000 }]
            },
            {
                id: "visit_26_007", createdAt: 1774214400000, comp: "المركز الطبي التخصصي", address: "جدة - التتحلية", mgr: "د. هاني الرفاعي",
                mob: "0554433221", email: "refai@medcenter.sa", record: "4030998811", visitDate: "22-03-2026",
                curServ: "سنترال وباقات اتصالات", oppValue: "9000", notes: "[]", status: "متابعة", editDate: "22-03-2026",
                owner: "محمد القحطاني", products: [{ name: "سنترال وباقات", qty: 1, price: 9000 }]
            },
            {
                id: "visit_001", createdAt: 1736841600000, comp: "شركة الأفق للحلول الرقمية", address: "الرياض - الصحافة", mgr: "فهد العتيبي",
                mob: "0501234567", email: "info@alofooq.sa", record: "1010345678", visitDate: "14-01-2025",
                curServ: "سنترال سحابي", oppValue: "5000", notes: "[]", status: "مميزة", editDate: "14-01-2025",
                owner: "أحمد الحربي", products: [{ name: "سنترال سحابي متطور", qty: 1, price: 5000 }]
            },
            {
                id: "visit_002", createdAt: 1737360000000, comp: "مستشفى الرعاية المتقدمة", address: "جدة - الحمراء", mgr: "د. طارق الغامدي",
                mob: "0552345678", email: "tariq@care.med", record: "4030112233", visitDate: "20-01-2025",
                curServ: "ربط فروع", oppValue: "12000", notes: "[]", status: "متابعة", editDate: "20-01-2025",
                owner: "محمد القحطاني", products: [{ name: "شبكة ربط فروع", qty: 2, price: 6000 }]
            },
            {
                id: "visit_003", createdAt: 1738051200000, comp: "وزارة الموارد البشرية", address: "الرياض - المعذر", mgr: "سلطان الدوسري",
                mob: "0543456789", email: "sdosari@hr.gov.sa", record: "7001234567", visitDate: "28-01-2025",
                curServ: "أمن سيبراني", oppValue: "25000", notes: "[]", status: "عرض سعر", editDate: "28-01-2025",
                owner: "أحمد الحربي", products: [{ name: "باقة حماية أمنية", qty: 1, price: 25000 }]
            },
            {
                id: "visit_004", createdAt: 1738742400000, comp: "مجموعة البناء الحديث", address: "الدمام - الشاطئ", mgr: "م. حسام الزهراني",
                mob: "0564567890", email: "husam@modernbuild.com", record: "2050987654", visitDate: "05-02-2025",
                curServ: "كاميرات مراقبة", oppValue: "0", notes: "[]", status: "غير مهتم", editDate: "05-02-2025",
                owner: "خالد الشمري", products: []
            },
            {
                id: "visit_005", createdAt: 1739347200000, comp: "مؤسسة الابتكار للتجارة", address: "المدينة - قباء", mgr: "صالح المولد",
                mob: "0575678901", email: "saleh@ebtekar.com", record: "4650334455", visitDate: "12-02-2025",
                curServ: "نقاط بيع", oppValue: "0", notes: "[]", status: "فقدان", editDate: "12-02-2025",
                owner: "سارة العتيبي", products: []
            }
        ];
        updateDynamicOwnerFilter();
        updateStats();
        filterTable();
    }

    try {
        if (db) {
            const visitsRef = collection(db, "visits");
            onSnapshot(visitsRef, (snapshot) => {
                let hasStructuralChanges = false;
                let batchCache = {};
                try { 
                    const raw = localStorage.getItem(VISITS_LOCAL_KEY);
                    if (raw) {
                        const parsed = JSON.parse(raw);
                        batchCache = Array.isArray(parsed) ? {} : parsed;
                    }
                } catch(e){}

                if (!snapshot.empty) {
                    snapshot.forEach((docSnap) => {
                        let data = docSnap.data();
                        data.id = docSnap.id;
                        normalizeVisitData(data);
                        if (!data.createdAt) {
                            data.createdAt = getVisitTimestamp(data);
                        }

                        const mainRow = document.getElementById(data.id);
                        const isBeingEdited = mainRow && (
                            mainRow.contains(document.activeElement) ||
                            Boolean(saveTimeouts[data.id])
                        );

                        const index = visitsDataArray.findIndex(v => v.id === data.id);
                        if (index === -1) {
                            visitsDataArray.unshift(data);
                            batchCache[data.id] = data;
                            hasStructuralChanges = true;
                        } else {
                            if (isBeingEdited) {
                                batchCache[data.id] = visitsDataArray[index];
                            } else {
                                visitsDataArray[index] = { ...visitsDataArray[index], ...data };
                                batchCache[data.id] = visitsDataArray[index];
                                updateRowDOM(visitsDataArray[index]);
                            }
                        }
                    });
                    try { localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(batchCache)); } catch(e){}
                }

                if (!snapshot.empty) {
                    const snapshotIds = new Set(snapshot.docs.map(d => d.id));
                    const oldLength = visitsDataArray.length;
                    visitsDataArray = visitsDataArray.filter(v => snapshotIds.has(v.id) || Boolean(saveTimeouts[v.id]) || (document.getElementById(v.id)?.contains(document.activeElement)));
                    if (visitsDataArray.length !== oldLength) {
                        hasStructuralChanges = true;
                    }
                }

                const seen = new Set();
                const deduped = [];
                for (const v of visitsDataArray) {
                    if (v && v.id && !seen.has(v.id)) {
                        seen.add(v.id);
                        deduped.push(v);
                    }
                }
                if (deduped.length !== visitsDataArray.length) {
                    visitsDataArray = deduped;
                    hasStructuralChanges = true;
                }

                updateDynamicOwnerFilter();
                updateStats();

                if (isInitialLoad || hasStructuralChanges) {
                    let activeInfo = null;
                    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
                        const tr = document.activeElement.closest('tr');
                        if (tr) {
                            syncRowToMemory(tr.id);
                            activeInfo = {
                                id: tr.id,
                                className: document.activeElement.className,
                                colClass: document.activeElement.closest('td')?.className || ''
                            };
                            try { activeInfo.selStart = document.activeElement.selectionStart; } catch(e){}
                        }
                    }

                    filterTable();
                    isInitialLoad = false;

                    if (activeInfo) {
                        const tr = document.getElementById(activeInfo.id);
                        if (tr) {
                            let targetInput = null;
                            if (activeInfo.colClass) {
                                targetInput = tr.querySelector(`td.${activeInfo.colClass.split(' ')[0]} input`);
                            }
                            if (!targetInput) {
                                targetInput = tr.querySelector(`.${activeInfo.className.split(' ')[0]}`);
                            }
                            if (targetInput) {
                                targetInput.focus();
                                try { if (activeInfo.selStart !== null) targetInput.setSelectionRange(activeInfo.selStart, activeInfo.selStart); } catch(e){}
                            }
                        }
                    }
                }

                markPageReady(); 
            }, (error) => { console.warn("ملاحظة مزامنة الزيارات السحابية:", error); });
        }
    } catch(e) {
        console.warn("Notice: Local mode active:", e);
    }
}

function applyStatusColor(selectEl) {
    if (!selectEl) return;
    selectEl.className = 'excel-input status-select';
    const val = selectEl.value.trim();
    if (val === 'تأهيل لفرصة') selectEl.classList.add('status-green');
    else if (val === 'مميزة') selectEl.classList.add('status-purple');
    else if (val === 'متابعة') selectEl.classList.add('status-yellow-fff');
    else if (val === 'عرض سعر') selectEl.classList.add('status-yellow-ffc');
    else if (val === 'غير مهتم') selectEl.classList.add('status-gray-a5');
    else if (val === 'فقدان') selectEl.classList.add('status-red-c00');
    
    const tr = selectEl.closest('tr');
    if (tr) {
        tr.classList.remove('row-lost', 'row-uninterested');
        if (val === 'فقدان') tr.classList.add('row-lost');
        else if (val === 'غير مهتم') tr.classList.add('row-uninterested');
    }
}

function updateRowDOM(v) {
    const mainRow = document.getElementById(v.id);
    if (!mainRow) return;

    if (mainRow.contains(document.activeElement) || Boolean(saveTimeouts[v.id])) {
        return;
    }

    const safeUpdate = (selector, newVal, syncTitle = false) => {
        const el = mainRow.querySelector(selector);
        if (el && document.activeElement !== el) {
            if (el.tagName === 'INPUT' || el.tagName === 'SELECT') { el.value = newVal; } 
            else { el.innerHTML = newVal; }
        }
        if (el && syncTitle) {
            el.title = newVal || '';
            const parentTd = el.closest('td');
            if (parentTd) parentTd.title = newVal || '';
        }
    };

    safeUpdate('td.col-company input', v.comp || '', true);
    safeUpdate('td.col-address input', v.address || '', true);
    safeUpdate('td.col-manager input', v.mgr || '', true);
    safeUpdate('td.col-mobile input', toEnglishDigits(v.mob || '').replace(/\D/g, ''));
    safeUpdate('td.col-email input', v.email || '');
    safeUpdate('td.col-record input', toEnglishDigits(v.record || ''));
    safeUpdate('.visit-date-val', formatAsDDMMYYYY(v.visitDate || getTodayFormatted()));
    safeUpdate('.cur-serv-val', v.curServ || '');
    
    const calculatedOppVal = calculateProductsTotalSum(v.products);
    safeUpdate('.opp-value-input', formatEnglishNumber(calculatedOppVal));
    
    const statusSelect = mainRow.querySelector('.status-select');
    if (statusSelect && document.activeElement !== statusSelect) {
        statusSelect.value = v.status || ''; 
        applyStatusColor(statusSelect);
    }
    safeUpdate('.owner-input', v.owner || '');
    
    const hiddenEditDate = mainRow.querySelector('.edit-date-val');
    if (hiddenEditDate) hiddenEditDate.value = v.editDate || v.visitDate || '';
    const editMains = mainRow.querySelector('.edit-date-container-main');
    if (editMains) editMains.innerHTML = parseEditDateHTML(v.editDate || '', v.visitDate || '');

    const waBtn = mainRow.querySelector('.whatsapp-icon-btn');
    if (waBtn) {
        const cleaned = cleanPhone(v.mob);
        if (cleaned) {
            waBtn.href = `https://wa.me/${cleaned}`;
            waBtn.style.display = 'inline-flex';
        } else {
            waBtn.style.display = 'none';
        }
    }

    let notesJson = v.notes || "[]";
    const noteEl = mainRow.querySelector('.notes-preview');
    if (noteEl) { 
        noteEl.setAttribute('data-full-notes', notesJson); 
        noteEl.innerText = getLastNoteOnlyFromJSON(notesJson); 
    }
}

function calculateProductsTotalSum(products) {
    if (!Array.isArray(products) || products.length === 0) return 0;
    return products.reduce((sum, p) => sum + (Number(toEnglishDigits(p.qty) || 1) * Number(toEnglishDigits(p.price) || 0)), 0);
}

function renderRowHTML(v) {
    const visitDateFormatted = formatAsDDMMYYYY(v.visitDate || getTodayFormatted());
    const phoneClean = cleanPhone(v.mob);
    const calculatedOppVal = calculateProductsTotalSum(v.products);

    let rowClass = 'main-row';
    if (v.status === 'فقدان') rowClass += ' row-lost';
    if (v.status === 'غير مهتم') rowClass += ' row-uninterested';

    return `
    <tr id="${v.id}" class="${rowClass}">
        <td class="col-select">
            <input type="checkbox" class="select-check" data-id="${v.id}">
            <span class="toggle-arrow" onclick="toggleSubTable('${v.id}')"><i class="fas fa-caret-left"></i></span>
        </td>
        <td class="col-company" title="${escapeHTML(v.comp || '')}"><input type="text" class="excel-input" value="${escapeHTML(v.comp || '')}" data-old="${escapeHTML(v.comp || '')}" title="${escapeHTML(v.comp || '')}" onfocus="this.dataset.old=this.value" oninput="this.title=this.value; if(this.parentElement) this.parentElement.title=this.value; debouncedSaveRow('${v.id}')" onchange="this.title=this.value; if(this.parentElement) this.parentElement.title=this.value; debouncedSaveRow('${v.id}')" onblur="handleVisitFieldBlur(this, 'الشركة')"></td>
        <td class="col-address" title="${escapeHTML(v.address || '')}"><input type="text" class="excel-input" value="${escapeHTML(v.address || '')}" data-old="${escapeHTML(v.address || '')}" title="${escapeHTML(v.address || '')}" onfocus="this.dataset.old=this.value" oninput="this.title=this.value; if(this.parentElement) this.parentElement.title=this.value; debouncedSaveRow('${v.id}')" onchange="this.title=this.value; if(this.parentElement) this.parentElement.title=this.value; debouncedSaveRow('${v.id}')" onblur="handleVisitFieldBlur(this, 'العنوان')"></td>
        <td class="col-manager" title="${escapeHTML(v.mgr || '')}"><input type="text" class="excel-input" value="${escapeHTML(v.mgr || '')}" data-old="${escapeHTML(v.mgr || '')}" title="${escapeHTML(v.mgr || '')}" onfocus="this.dataset.old=this.value" oninput="this.title=this.value; if(this.parentElement) this.parentElement.title=this.value; debouncedSaveRow('${v.id}')" onchange="this.title=this.value; if(this.parentElement) this.parentElement.title=this.value; debouncedSaveRow('${v.id}')" onblur="handleVisitFieldBlur(this, 'المسؤول')"></td>
        <td class="col-mobile">
            <div class="phone-cell-container">
                <input type="text" inputmode="numeric" class="excel-input" value="${escapeHTML(toEnglishDigits(v.mob || '').replace(/\D/g, ''))}" data-old="${escapeHTML(toEnglishDigits(v.mob || '').replace(/\D/g, ''))}" onfocus="this.dataset.old=this.value" oninput="sanitizeMobileInput(this, '${v.id}')" onpaste="handleMobilePaste(event, this, '${v.id}')" onkeydown="if(!/^[0-9٠-٩]$/.test(event.key) && !['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End','Enter'].includes(event.key) && !event.ctrlKey && !event.metaKey) { event.preventDefault(); }" onchange="sanitizeMobileInput(this, '${v.id}')" onblur="handleVisitFieldBlur(this, 'رقم التواصل')">
                <a href="https://wa.me/${phoneClean}" target="_blank" class="whatsapp-icon-btn" style="${phoneClean ? 'display:inline-flex;' : 'display:none;'}"><i class="fab fa-whatsapp"></i></a>
            </div>
        </td>
        <td class="col-email"><input type="email" class="excel-input" value="${escapeHTML(v.email || '')}" data-old="${escapeHTML(v.email || '')}" onfocus="this.dataset.old=this.value" oninput="debouncedSaveRow('${v.id}')" onchange="debouncedSaveRow('${v.id}')" onblur="handleVisitFieldBlur(this, 'البريد الالكتروني')"></td>
        <td class="col-record"><input type="text" inputmode="numeric" class="excel-input" value="${escapeHTML(toEnglishDigits(v.record || ''))}" data-old="${escapeHTML(toEnglishDigits(v.record || ''))}" onfocus="this.dataset.old=this.value" oninput="this.value = toEnglishDigits(this.value).replace(/[^0-9]/g, ''); debouncedSaveRow('${v.id}')" onkeydown="if(!/^[0-9٠-٩]$/.test(event.key) && !['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End','Enter'].includes(event.key) && !event.ctrlKey && !event.metaKey) { event.preventDefault(); }" onchange="debouncedSaveRow('${v.id}')" onblur="handleVisitFieldBlur(this, 'السجل التجاري')"></td>
        <td class="col-date">
            <input type="text" class="excel-input readonly-input visit-date-val" value="${escapeHTML(visitDateFormatted)}" readonly tabindex="-1" style="color: #000000 !important; font-weight: 700; cursor: default; user-select: none; background: transparent; text-align: center;">
        </td>
        <td class="col-service"><input type="text" class="excel-input cur-serv-val" value="${escapeHTML(v.curServ || '')}" data-old="${escapeHTML(v.curServ || '')}" onfocus="this.dataset.old=this.value" oninput="debouncedSaveRow('${v.id}')" onchange="debouncedSaveRow('${v.id}')" onblur="handleVisitFieldBlur(this, 'الخدمة')"></td>
        <td class="col-val"><input type="text" class="excel-input opp-value-input readonly-input" value="${formatEnglishNumber(calculatedOppVal)}" readonly></td>
        <td class="col-notes">
            <span class="notes-preview" data-full-notes="${escapeHTML(v.notes || '[]')}" onclick="openNote(this)">
                ${escapeHTML(getLastNoteOnlyFromJSON(v.notes))}
            </span>
        </td>
        <td class="col-status">
            <select class="excel-input status-select" data-old="${escapeHTML(v.status || '')}" onfocus="this.dataset.old=this.value" onchange="onStatusChange(this, '${v.id}')">
                <option value="">-- اختر --</option>
                <option value="تأهيل لفرصة" ${v.status === 'تأهيل لفرصة' ? 'selected' : ''}>تأهيل لفرصة</option>
                <option value="مميزة" ${v.status === 'مميزة' ? 'selected' : ''}>مميزة</option>
                <option value="متابعة" ${v.status === 'متابعة' ? 'selected' : ''}>متابعة</option>
                <option value="عرض سعر" ${v.status === 'عرض سعر' ? 'selected' : ''}>عرض سعر</option>
                <option value="زيارة" ${v.status === 'زيارة' ? 'selected' : ''}>زيارة</option>
                <option value="اتصال" ${v.status === 'اتصال' ? 'selected' : ''}>اتصال</option>
                <option value="غير مهتم" ${v.status === 'غير مهتم' ? 'selected' : ''}>غير مهتم</option>
                <option value="فقدان" ${v.status === 'فقدان' ? 'selected' : ''}>فقدان</option>
            </select>
        </td>
        <td class="col-edit">
            <input type="hidden" class="edit-date-val" value="${escapeHTML(v.editDate || v.visitDate || '')}">
            <div class="edit-date-container-main">${parseEditDateHTML(v.editDate || '', v.visitDate || '')}</div>
        </td>
        <td class="col-owner"><input type="text" class="excel-input owner-input" value="${escapeHTML(v.owner || '')}" data-old="${escapeHTML(v.owner || '')}" onfocus="this.dataset.old=this.value" oninput="debouncedSaveRow('${v.id}')" onchange="debouncedSaveRow('${v.id}')" onblur="handleVisitFieldBlur(this, 'المستخدم')"></td>
    </tr>
    ${renderSubTableHTML(v)}`;
}

function renderSubTableHTML(v) {
    const products = Array.isArray(v.products) ? v.products : [];
    let rowsHtml = products.map((p, idx) => {
        const qtyNum = Number(toEnglishDigits(p.qty !== undefined ? p.qty : 1)) || 1;
        const priceNum = Number(toEnglishDigits(p.price !== undefined ? p.price : 0)) || 0;
        const totalNum = qtyNum * priceNum;
        return `
        <tr data-index="${idx}">
            <td><input type="text" class="p-name" value="${escapeHTML(p.name || '')}" oninput="recalculateAndSaveProducts('${v.id}')"></td>
            <td><input type="text" inputmode="numeric" class="p-qty excel-input" value="${qtyNum}" oninput="this.value = toEnglishDigits(this.value).replace(/[^0-9]/g, ''); updateProductTotal(this, '${v.id}')" onkeydown="if(!/^[0-9٠-٩]$/.test(event.key) && !['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End','Enter'].includes(event.key) && !event.ctrlKey && !event.metaKey) { event.preventDefault(); }"></td>
            <td><input type="text" inputmode="numeric" class="p-price excel-input" value="${priceNum}" oninput="this.value = toEnglishDigits(this.value).replace(/[^0-9.]/g, ''); updateProductTotal(this, '${v.id}')" onkeydown="if(!/^[0-9٠-٩.]$/.test(event.key) && !['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End','Enter'].includes(event.key) && !event.ctrlKey && !event.metaKey) { event.preventDefault(); }"></td>
            <td><input type="text" class="p-total readonly-input" value="${formatEnglishNumber(totalNum)}" readonly></td>
            <td style="text-align:center;">
                <button type="button" class="sub-action-btn" onclick="removeProductRow(this, '${v.id}')" title="حذف المنتج"><i class="fas fa-trash-alt"></i></button>
            </td>
        </tr>
    `}).join('');

    return `
    <tr id="sub-${v.id}" class="sub-table-row">
        <td colspan="14">
            <div class="sub-table-container">
                <table class="inner-table">
                    <thead>
                        <tr>
                            <th style="width: 40%;">المنتج / الخدمة <button type="button" class="header-plus-btn" onclick="addProductRow('${v.id}')" title="إضافة منتج">+</button></th>
                            <th style="width: 15%;">الكمية</th>
                            <th style="width: 20%;">السعر</th>
                            <th style="width: 20%;">الإجمالي</th>
                            <th style="width: 5%;">إجراء</th>
                        </tr>
                    </thead>
                    <tbody class="product-body">
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        </td>
    </tr>`;
}

function fullTableRender(dataArray = null) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;

    const rawList = dataArray || visitsDataArray;
    const seenIds = new Set();
    const list = [];
    rawList.forEach(v => {
        if (v && v.id && !seenIds.has(v.id)) {
            seenIds.add(v.id);
            list.push(v);
        }
    });

    let fullHTML = '';
    let currentMonthYear = '';

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;padding:28px;color:var(--text-muted);font-weight:700;">لا توجد بيانات مطابقة للفرز والبحث</td></tr>`;
        updateMasterCheckboxState();
        return;
    }

    const sortedList = [...list].sort((a, b) => {
        const dateA = parseDate(a.visitDate).getTime();
        const dateB = parseDate(b.visitDate).getTime();
        if (dateB !== dateA) {
            return dateB - dateA;
        }
        const timeA = getVisitTimestamp(a);
        const timeB = getVisitTimestamp(b);
        if (timeB !== timeA) {
            return timeB - timeA;
        }
        return String(b.id || '').localeCompare(String(a.id || ''));
    });

    sortedList.forEach(v => {
        const dObj = parseDate(v.visitDate);
        if (!isNaN(dObj.getTime()) && dObj.getFullYear() > 1970) {
            const monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
            const myStr = `${monthNames[dObj.getMonth()]} ${dObj.getFullYear()}`;
            if (myStr !== currentMonthYear) {
                currentMonthYear = myStr;
                fullHTML += `<tr class="month-separator"><td colspan="14"><div class="sep-text">${currentMonthYear}</div></td></tr>`;
            }
        }
        fullHTML += renderRowHTML(v);
    });

    tbody.innerHTML = fullHTML;
    tbody.querySelectorAll('.status-select').forEach(select => applyStatusColor(select));
    updateMasterCheckboxState();
    enforceEnglishDigitsInDOM();

    const highlightId = new URLSearchParams(window.location.search).get('highlight');
    if (highlightId && typeof window.triggerElementHighlight === 'function') {
        setTimeout(() => window.triggerElementHighlight(highlightId), 80);
    }
}

function toggleSubTable(rowId) {
    const subRow = document.getElementById('sub-' + rowId);
    const arrow = document.querySelector(`#${rowId} .toggle-arrow`);
    if (subRow) {
        const isVisible = subRow.style.display === 'table-row';
        subRow.style.display = isVisible ? 'none' : 'table-row';
        if (arrow) {
            if (isVisible) arrow.classList.remove('arrow-open');
            else arrow.classList.add('arrow-open');
        }
    }
}

function addProductRow(visitId) {
    const subRow = document.getElementById('sub-' + visitId);
    if (!subRow) return;
    const tbody = subRow.querySelector('.product-body');
    if (!tbody) return;

    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="p-name" placeholder="اسم المنتج/الخدمة..." value="" oninput="recalculateAndSaveProducts('${visitId}')"></td>
        <td><input type="text" inputmode="numeric" class="p-qty excel-input" value="1" oninput="this.value = toEnglishDigits(this.value).replace(/[^0-9]/g, ''); updateProductTotal(this, '${visitId}')" onkeydown="if(!/^[0-9٠-٩]$/.test(event.key) && !['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End','Enter'].includes(event.key) && !event.ctrlKey && !event.metaKey) { event.preventDefault(); }"></td>
        <td><input type="text" inputmode="numeric" class="p-price excel-input" value="0" oninput="this.value = toEnglishDigits(this.value).replace(/[^0-9.]/g, ''); updateProductTotal(this, '${visitId}')" onkeydown="if(!/^[0-9٠-٩.]$/.test(event.key) && !['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End','Enter'].includes(event.key) && !event.ctrlKey && !event.metaKey) { event.preventDefault(); }"></td>
        <td><input type="text" class="p-total readonly-input" value="0" readonly></td>
        <td style="text-align:center;">
            <button type="button" class="sub-action-btn" onclick="removeProductRow(this, '${visitId}')" title="حذف المنتج"><i class="fas fa-trash-alt"></i></button>
        </td>
    `;
    tbody.appendChild(tr);
    tr.querySelector('.p-name')?.focus();
}

function removeProductRow(btn, visitId) {
    const tr = btn.closest('tr');
    if (tr) {
        tr.remove();
        recalculateAndSaveProducts(visitId);
    }
}

function updateProductTotal(inputEl, visitId) {
    const tr = inputEl.closest('tr');
    if (!tr) return;
    if (inputEl) {
        if (inputEl.classList.contains('p-qty')) {
            inputEl.value = toEnglishDigits(inputEl.value).replace(/[^0-9]/g, '');
        } else {
            inputEl.value = toEnglishDigits(inputEl.value).replace(/[^0-9.]/g, '');
        }
    }
    const rawQty = toEnglishDigits(tr.querySelector('.p-qty')?.value || '1');
    const rawPrice = toEnglishDigits(tr.querySelector('.p-price')?.value || '0');
    const qty = Number(rawQty) || 0;
    const price = Number(rawPrice) || 0;
    const totalEl = tr.querySelector('.p-total');
    if (totalEl) totalEl.value = formatEnglishNumber(qty * price);
    
    recalculateAndSaveProducts(visitId);
}

function recalculateAndSaveProducts(visitId) {
    const mainRow = document.getElementById(visitId);
    const subRow = document.getElementById('sub-' + visitId);
    let currentProducts = [];
    if (subRow) {
        subRow.querySelectorAll('.product-body tr').forEach(pRow => {
            const name = pRow.querySelector('.p-name')?.value || '';
            const rawQty = toEnglishDigits(pRow.querySelector('.p-qty')?.value || '1');
            const rawPrice = toEnglishDigits(pRow.querySelector('.p-price')?.value || '0');
            const pQty = Number(rawQty) || 0;
            const pPrice = Number(rawPrice) || 0;
            if (name.trim()) currentProducts.push({ name: name.trim(), qty: pQty, price: pPrice });
        });
    }
    const totalSum = calculateProductsTotalSum(currentProducts);
    if (mainRow) {
        const oppValInput = mainRow.querySelector('.opp-value-input');
        if (oppValInput) oppValInput.value = formatEnglishNumber(totalSum);
    }
    debouncedSaveRow(visitId);
}

async function transferToOpportunities(rowId, visitData) {
    try {
        if (saveTimeouts[rowId]) {
            clearTimeout(saveTimeouts[rowId]);
            delete saveTimeouts[rowId];
        }

        const opportunityPayload = {
            id: rowId,
            comp: visitData.comp || '',
            address: visitData.address || '',
            mgr: visitData.mgr || '',
            mob: visitData.mob || '',
            email: visitData.email || '',
            record: visitData.record || '',
            oppDate: visitData.visitDate || getTodayFormatted(),
            visitDate: visitData.visitDate || getTodayFormatted(),
            curServ: visitData.curServ || '',
            oppValue: visitData.oppValue || '0',
            notes: visitData.notes || '[]',
            status: 'تأهيل لفرصة',
            editDate: getTodayFormatted(),
            owner: visitData.owner || '',
            products: visitData.products || []
        };

        if (db) {
            const batch = writeBatch(db);
            const oppRef = doc(db, "opportunities", rowId);
            const visitRef = doc(db, "visits", rowId);
            batch.set(oppRef, opportunityPayload);
            batch.delete(visitRef);
            await batch.commit();
        }

        try {
            let visitsCache = JSON.parse(localStorage.getItem(VISITS_LOCAL_KEY) || '{}');
            delete visitsCache[rowId];
            localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(visitsCache));

            let oppsCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
            oppsCache[rowId] = opportunityPayload;
            localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(oppsCache));
        } catch(e){}

        visitsDataArray = visitsDataArray.filter(v => v.id !== rowId);
        filterTable();
        
        SafeSwal.fire({
            title: 'تم النقل بنجاح',
            text: 'تم نقل الزيارة إلى جدول الفرص البيعية وإزالتها من الزيارات',
            icon: 'success',
            timer: 2000,
            showConfirmButton: false
        });
    } catch (e) {
        console.error("خطأ أثناء نقل الزيارة إلى الفرص البيعية:", e);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء نقل الزيارة إلى الفرص البيعية', 'error');
    }
}

function syncRowToMemory(rowId) {
    const mainRow = document.getElementById(rowId);
    if (!mainRow) return;

    const comp = mainRow.querySelector('td.col-company input')?.value || '';
    const address = mainRow.querySelector('td.col-address input')?.value || '';
    const mgr = mainRow.querySelector('td.col-manager input')?.value || '';
    const mob = toEnglishDigits(mainRow.querySelector('td.col-mobile input')?.value || '').replace(/[^0-9]/g, '');
    const email = mainRow.querySelector('td.col-email input')?.value || '';
    const record = toEnglishDigits(mainRow.querySelector('td.col-record input')?.value || '').replace(/[^0-9]/g, '');
    const rawVisitDate = mainRow.querySelector('.visit-date-val')?.value || getTodayFormatted();
    const visitDate = toEnglishDigits(rawVisitDate);
    const curServ = mainRow.querySelector('.cur-serv-val')?.value || '';
    const statusSelect = mainRow.querySelector('.status-select');
    const status = statusSelect ? statusSelect.value : '';
    const owner = mainRow.querySelector('.owner-input')?.value || '';
    const editDate = getTodayFormatted();

    const existing = visitsDataArray.find(v => v.id === rowId);
    const createdAt = existing?.createdAt || getVisitTimestamp(existing) || (rowId.match(/(\d+)/) ? parseInt(rowId.match(/(\d+)/)[1], 10) : Date.now());
    const products = existing?.products || [];
    const notes = existing?.notes || '[]';
    const oppValue = calculateProductsTotalSum(products);

    const updated = {
        id: rowId,
        createdAt,
        comp, address, mgr, mob, email, record, visitDate, curServ,
        oppValue: String(oppValue), notes, status, editDate, owner, products
    };

    const vIdx = visitsDataArray.findIndex(v => v.id === rowId);
    if (vIdx !== -1) {
        visitsDataArray[vIdx] = updated;
    } else {
        visitsDataArray.unshift(updated);
    }

    try {
        let localCache = JSON.parse(localStorage.getItem(VISITS_LOCAL_KEY) || '{}');
        localCache[rowId] = updated;
        localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(localCache));
    } catch(e){}
}

async function saveSingleRow(rowId) {
    if (saveTimeouts[rowId]) {
        clearTimeout(saveTimeouts[rowId]);
        delete saveTimeouts[rowId];
    }
    const mainRow = document.getElementById(rowId);
    if (!mainRow) return;

    const comp = mainRow.querySelector('td.col-company input')?.value || '';
    const address = mainRow.querySelector('td.col-address input')?.value || '';
    const mgr = mainRow.querySelector('td.col-manager input')?.value || '';
    const mob = toEnglishDigits(mainRow.querySelector('td.col-mobile input')?.value || '').replace(/[^0-9]/g, '');
    const email = mainRow.querySelector('td.col-email input')?.value || '';
    const record = toEnglishDigits(mainRow.querySelector('td.col-record input')?.value || '').replace(/[^0-9]/g, '');
    const rawVisitDate = mainRow.querySelector('.visit-date-val')?.value || getTodayFormatted();
    const visitDate = toEnglishDigits(rawVisitDate);
    const curServ = mainRow.querySelector('.cur-serv-val')?.value || '';
    
    const notesPreview = mainRow.querySelector('.notes-preview');
    const notes = notesPreview ? notesPreview.getAttribute('data-full-notes') || '[]' : '[]';
    
    const statusSelect = mainRow.querySelector('.status-select');
    const status = statusSelect ? statusSelect.value : '';
    const owner = mainRow.querySelector('.owner-input')?.value || '';
    
    const editDate = getTodayFormatted();

    const subRow = document.getElementById('sub-' + rowId);
    let products = [];
    if (subRow) {
        subRow.querySelectorAll('.product-body tr').forEach(pRow => {
            const name = pRow.querySelector('.p-name')?.value || '';
            const rawQty = toEnglishDigits(pRow.querySelector('.p-qty')?.value || '1');
            const rawPrice = toEnglishDigits(pRow.querySelector('.p-price')?.value || '0');
            const qty = Number(rawQty) || 0;
            const price = Number(rawPrice) || 0;
            if (name.trim()) products.push({ name: name.trim(), qty, price });
        });
    } else {
        const existing = visitsDataArray.find(v => v.id === rowId);
        if (existing) products = existing.products || [];
    }

    const oppValue = calculateProductsTotalSum(products);
    const oppValueInput = mainRow.querySelector('.opp-value-input');
    if (oppValueInput) oppValueInput.value = formatEnglishNumber(oppValue);

    const existing = visitsDataArray.find(v => v.id === rowId);
    const createdAt = existing?.createdAt || getVisitTimestamp(existing) || (rowId.match(/(\d+)/) ? parseInt(rowId.match(/(\d+)/)[1], 10) : Date.now());

    const currentVisitData = {
        id: rowId,
        createdAt,
        comp, address, mgr, mob, email, record, visitDate, curServ,
        oppValue: String(oppValue), notes, status, editDate, owner, products
    };

    const vIdx = visitsDataArray.findIndex(v => v.id === rowId);
    if (vIdx !== -1) {
        visitsDataArray[vIdx] = currentVisitData;
    } else {
        visitsDataArray.unshift(currentVisitData);
    }

    try {
        let localCache = JSON.parse(localStorage.getItem(VISITS_LOCAL_KEY) || '{}');
        localCache[rowId] = currentVisitData;
        localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(localCache));

        let rawCusts = localStorage.getItem('crm_customers');
        if (rawCusts) {
            let custs = JSON.parse(rawCusts);
            let custChanged = false;
            const nowIso = new Date().toISOString();
            custs.forEach(c => {
                if (isCustomerMatchedByCr(c, currentVisitData)) {
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

    if (status === 'تأهيل لفرصة') {
        await transferToOpportunities(rowId, currentVisitData);
        return;
    }

    try {
        if (db) {
            await setDoc(doc(db, "visits", rowId), currentVisitData, { merge: true });
        }
        updateEditDateField(mainRow);
    } catch(e) {
        console.error("Error saving row:", e);
    }
}

function debouncedSaveRow(rowId) {
    syncRowToMemory(rowId);
    if (saveTimeouts[rowId]) clearTimeout(saveTimeouts[rowId]);
    saveTimeouts[rowId] = setTimeout(() => saveSingleRow(rowId), 500);
}

function onStatusChange(selectEl, rowId) {
    const oldVal = selectEl.dataset.old || '';
    const val = selectEl.value.trim();
    const row = document.getElementById(rowId);
    const comp = row?.querySelector('td.col-company input')?.value || '';
    const owner = row?.querySelector('.owner-input')?.value || '';
    applyStatusColor(selectEl);
    updateEditDateField(row);
    addToActivityLog('الحالة', oldVal, val, comp, owner);
    selectEl.dataset.old = val;
    saveSingleRow(rowId);
}

function debouncedFilterTable() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(filterTable, 250);
}

function filterTable() {
    const query = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
    
    const statusCbs = document.querySelectorAll('#statusFilterMenu input[type="checkbox"]');
    totalStatusOptionsCount = statusCbs.length || 8;

    const ownerCbs = document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]');
    totalOwnerOptionsCount = ownerCbs.length;

    if (totalStatusOptionsCount > 0 && activeStatusFilters.length === 0 && !userHasExplicitlyFilteredStatus) {
        const checked = Array.from(document.querySelectorAll('#statusFilterMenu input[type="checkbox"]:checked')).map(c => c.value);
        activeStatusFilters = checked.length > 0 ? checked : ['تأهيل لفرصة', 'مميزة', 'متابعة', 'عرض سعر', 'زيارة', 'اتصال', 'غير مهتم', 'فقدان'];
    }

    if (totalOwnerOptionsCount > 0 && activeOwnerFilters.length === 0 && !userHasExplicitlyFilteredOwner) {
        const checked = Array.from(document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]:checked')).map(c => c.value);
        if (checked.length > 0) {
            activeOwnerFilters = checked;
        } else {
            activeOwnerFilters = Array.from(ownerCbs).map(c => c.value);
        }
    }

    const filtered = visitsDataArray.filter(v => {
        const matchSearch = !query || [v.comp, v.address, v.mgr, v.mob, v.email, v.record, v.curServ, v.owner, v.status].some(val => String(val || '').toLowerCase().includes(query));
        if (!matchSearch) return false;

        if (userHasExplicitlyFilteredStatus && totalStatusOptionsCount > 0 && activeStatusFilters.length < totalStatusOptionsCount) {
            const vStatus = (v.status || '').trim();
            if (!activeStatusFilters.includes(vStatus)) return false;
        }

        if (userHasExplicitlyFilteredOwner && totalOwnerOptionsCount > 0 && activeOwnerFilters.length < totalOwnerOptionsCount) {
            const vOwner = (v.owner || '').trim();
            if (!activeOwnerFilters.includes(vOwner)) return false;
        }

        return true;
    });

    fullTableRender(filtered);
    updateStats(filtered);
}

function toggleCustomFilter(event, menuId) {
    event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
    if (!isShown) menu.classList.add('show');
}

function updateFilters() {
    const statusCbs = document.querySelectorAll('#statusFilterMenu input[type="checkbox"]');
    totalStatusOptionsCount = statusCbs.length;
    activeStatusFilters = Array.from(document.querySelectorAll('#statusFilterMenu input[type="checkbox"]:checked')).map(c => c.value);
    userHasExplicitlyFilteredStatus = (activeStatusFilters.length < totalStatusOptionsCount);
    
    const statusDot = document.getElementById('statusFilterDot');
    if (statusDot) {
        statusDot.style.display = userHasExplicitlyFilteredStatus ? 'block' : 'none';
    }

    const ownerCbs = document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]');
    totalOwnerOptionsCount = ownerCbs.length;
    activeOwnerFilters = Array.from(document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]:checked')).map(c => c.value);
    userHasExplicitlyFilteredOwner = (activeOwnerFilters.length < totalOwnerOptionsCount);
    
    const ownerDot = document.getElementById('ownerFilterDot');
    if (ownerDot) {
        ownerDot.style.display = userHasExplicitlyFilteredOwner ? 'block' : 'none';
    }

    filterTable();
}

function selectAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    if (menuId === 'statusFilterMenu') {
        userHasExplicitlyFilteredStatus = false;
    } else if (menuId === 'ownerFilterMenu') {
        userHasExplicitlyFilteredOwner = false;
    }
    updateFilters();
}

function clearAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    if (menuId === 'statusFilterMenu') {
        userHasExplicitlyFilteredStatus = true;
    } else if (menuId === 'ownerFilterMenu') {
        userHasExplicitlyFilteredOwner = true;
    }
    updateFilters();
}

function updateDynamicOwnerFilter() {
    const ownerContainer = document.getElementById('ownerFilterItemsContainer');
    if (!ownerContainer) return;
    const uniqueOwners = [...new Set(visitsDataArray.map(v => (v.owner || '').trim()).filter(Boolean))].sort();
    
    if (!userHasExplicitlyFilteredOwner) {
        activeOwnerFilters = [...uniqueOwners];
        isOwnerFilterInitialized = true;
    } else {
        uniqueOwners.forEach(owner => {
            if (!activeOwnerFilters.includes(owner)) {
                activeOwnerFilters.push(owner);
            }
        });
    }

    ownerContainer.innerHTML = uniqueOwners.map(owner => `
        <label class="multi-select-item">
            <input type="checkbox" value="${escapeHTML(owner)}" ${activeOwnerFilters.includes(owner) ? 'checked' : ''} onchange="updateFilters()">
            <span class="custom-cb"><i class="fas fa-check"></i></span>
            <span>${escapeHTML(owner)}</span>
        </label>
    `).join('');

    totalOwnerOptionsCount = uniqueOwners.length;
}

function updateStats(dataArray = null) {
    const list = dataArray || visitsDataArray;
    const todayStr = getTodayFormatted();
    const today = parseDate(todayStr);
    
    let total = list.length;
    let thisMonth = 0;
    let todayCount = 0;
    let totalVal = 0;
    let monthVal = 0;

    list.forEach(v => {
        const dObj = parseDate(v.visitDate);
        if (!isNaN(dObj.getTime())) {
            if (dObj.getMonth() === today.getMonth() && dObj.getFullYear() === today.getFullYear()) {
                thisMonth++;
                monthVal += Number(v.oppValue) || 0;
            }
            if (dObj.getDate() === today.getDate() && dObj.getMonth() === today.getMonth() && dObj.getFullYear() === today.getFullYear()) {
                todayCount++;
            }
        }
        totalVal += Number(v.oppValue) || 0;
    });

    if (document.getElementById('stat-total')) document.getElementById('stat-total').innerText = total;
    if (document.getElementById('stat-month')) document.getElementById('stat-month').innerText = thisMonth;
    if (document.getElementById('stat-today')) document.getElementById('stat-today').innerText = todayCount;
    if (document.getElementById('stat-value-total')) document.getElementById('stat-value-total').innerText = formatEnglishNumber(totalVal);
    if (document.getElementById('stat-value-month')) document.getElementById('stat-value-month').innerText = formatEnglishNumber(monthVal);
    enforceEnglishDigitsInDOM();
}

function toggleDropdown(event, btn) {
    event.stopPropagation();
    const parent = btn.closest('.bulk-action-wrapper');
    if (!parent) return;
    const menu = parent.querySelector('.dropdown-menu');
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    if (!isShown) menu.classList.add('show');
}

function exportToCSV(selectedIds) {
    let list = visitsDataArray;
    if (selectedIds && selectedIds.length > 0) {
        list = visitsDataArray.filter(v => selectedIds.includes(v.id));
    } else {
        const visibleRows = Array.from(document.querySelectorAll('#tableBody tr.main-row')).filter(isRowVisible);
        const visibleIds = visibleRows.map(r => r.id).filter(Boolean);
        list = visitsDataArray.filter(v => visibleIds.includes(v.id));
    }

    if (list.length === 0) {
        SafeSwal.fire('تنبيه', 'لا توجد بيانات ظاهرة للتصدير', 'info');
        return;
    }

    let csvContent = "\uFEFF";
    csvContent += "الشركة,العنوان,المسؤول,رقم التواصل,البريد الإلكتروني,السجل التجاري,تاريخ الزيارة,الخدمة,القيمة,الملاحظات,الحالة,آخر تعديل,المستخدم\n";

    list.forEach(v => {
        let cleanNotes = "";
        try {
            const parsedArr = JSON.parse(v.notes || "[]");
            cleanNotes = parsedArr.map(n => n.text || '').join(' | ');
        } catch(e) {
            cleanNotes = v.notes || "";
        }

        const row = [
            `"${(v.comp || '').replace(/"/g, '""')}"`,
            `"${(v.address || '').replace(/"/g, '""')}"`,
            `"${(v.mgr || '').replace(/"/g, '""')}"`,
            `"${(v.mob || '').replace(/"/g, '""')}"`,
            `"${(v.email || '').replace(/"/g, '""')}"`,
            `"${(v.record || '').replace(/"/g, '""')}"`,
            `"${(v.visitDate || '')}"`,
            `"${(v.curServ || '').replace(/"/g, '""')}"`,
            `"${v.oppValue || 0}"`,
            `"${cleanNotes.replace(/"/g, '""')}"`,
            `"${(v.status || '').replace(/"/g, '""')}"`,
            `"${(v.editDate || '')}"`,
            `"${(v.owner || '').replace(/"/g, '""')}"`
        ];
        csvContent += row.join(",") + "\n";
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `visits_export_${getTodayFormatted()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

async function handleImportExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (typeof XLSX === 'undefined') {
        SafeSwal.fire('خطأ', 'مكتبة قراءة ملفات الإكسيل لم يتم تحميلها بعد', 'error');
        event.target.value = '';
        return;
    }

    SafeSwal.fire({
        title: 'جاري الاستيراد...',
        text: 'يرجى الانتظار أثناء قراءة الملف وإدراج البيانات',
        allowOutsideClick: false,
        didOpen: () => { if (typeof window.Swal !== 'undefined') window.Swal.showLoading(); }
    });

    try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

        if (!jsonRows || jsonRows.length === 0) {
            SafeSwal.fire('تنبيه', 'الملف فارغ أو لا يحتوي على بيانات قابلة للقراءة', 'warning');
            event.target.value = '';
            return;
        }

        const today = getTodayFormatted();
        const timeStr = getTimeFormatted();
        const docPayloads = [];

        jsonRows.forEach((row, index) => {
            const getVal = (...keys) => {
                for (const k of keys) {
                    const foundKey = Object.keys(row).find(rk => rk.trim().toLowerCase() === k.trim().toLowerCase());
                    if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null && String(row[foundKey]).trim() !== "") {
                        return String(row[foundKey]).trim();
                    }
                }
                return "";
            };

            const comp = getVal("الشركة", "اسم الشركة", "Company");
            const address = getVal("العنوان", "Address");
            const mgr = getVal("المسؤول", "اسم المسؤول", "Manager");
            const mob = getVal("رقم التواصل", "الهاتف", "الموبايل", "الجوال", "Mobile", "Phone");
            const email = getVal("البريد الإلكتروني", "الإيميل", "Email");
            const record = getVal("السجل التجاري", "السجل", "السجل الرئيسي", "Record", "CR");
            const rawDate = getVal("تاريخ الزيارة", "التاريخ", "Date");
            const visitDate = rawDate ? formatAsDDMMYYYY(rawDate) : today;
            const curServ = getVal("الخدمة", "نوع الخدمة", "Service");
            const oppValue = getVal("القيمة", "Value") || "0";
            const rawNotes = getVal("الملاحظات", "ملاحظات", "Notes");
            const status = getVal("الحالة", "Status");
            const owner = getVal("المستخدم", "المالك", "User", "Owner");

            let notesArr = [];
            if (rawNotes) {
                try {
                    const parsed = JSON.parse(rawNotes);
                    if (Array.isArray(parsed)) {
                        notesArr = parsed;
                    } else {
                        notesArr = [{ user: "استيراد إكسيل", date: today, time: timeStr, text: String(rawNotes) }];
                    }
                } catch (e) {
                    notesArr = [{ user: "استيراد إكسيل", date: today, time: timeStr, text: String(rawNotes) }];
                }
            }
            const notesJson = JSON.stringify(notesArr);

            const newId = 'visit_' + Date.now() + '_' + index;
            docPayloads.push({
                id: newId,
                data: {
                    id: newId,
                    comp, address, mgr, mob, email, record,
                    visitDate, curServ, oppValue, notes: notesJson,
                    status, editDate: today, owner, products: []
                }
            });
        });

        if (db) {
            const CHUNK_SIZE = 400;
            for (let i = 0; i < docPayloads.length; i += CHUNK_SIZE) {
                const chunk = docPayloads.slice(i, i + CHUNK_SIZE);
                const batch = writeBatch(db);
                chunk.forEach(item => {
                    batch.set(doc(db, "visits", item.id), item.data);
                });
                await batch.commit();
            }
        }

        try {
            let localCache = JSON.parse(localStorage.getItem(VISITS_LOCAL_KEY) || '{}');
            docPayloads.forEach(item => {
                localCache[item.id] = item.data;
            });
            localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(localCache));
        } catch(e){}

        visitsDataArray = [...docPayloads.map(d => d.data), ...visitsDataArray];
        updateDynamicOwnerFilter();
        updateStats();
        filterTable();

        SafeSwal.fire({
            title: 'تم الاستيراد بنجاح',
            text: `تم إدراج ${docPayloads.length} زيارة بنجاح`,
            icon: 'success'
        });
    } catch (err) {
        console.error("خطأ أثناء استيراد الإكسيل:", err);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء معالجة ملف الإكسيل', 'error');
    } finally {
        event.target.value = '';
    }
}

async function handleBulkAction(actionType) {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    const checkedCheckboxes = Array.from(document.querySelectorAll('#tableBody tr.main-row .select-check:checked'))
        .filter(cb => isRowVisible(cb.closest('tr')));
    const selectedIds = checkedCheckboxes.map(cb => cb.getAttribute('data-id') || cb.closest('tr')?.id).filter(Boolean);

    if (actionType === 'طباعة') {
        window.print();
        return;
    }

    if (actionType === 'استيراد' || actionType === 'استيراد من Excel') {
        const fileInput = document.getElementById('excelFileInput');
        if (fileInput) fileInput.click();
        return;
    }

    if (actionType === 'تصدير' || actionType === 'تصدير إلى Excel') {
        exportToCSV(selectedIds);
        return;
    }

    if (selectedIds.length === 0) {
        SafeSwal.fire({
            title: 'تنبيه',
            text: 'يرجى تحديد عنصر واحد على الأقل من الصفوف الظاهرة للقيام بهذا الإجراء',
            icon: 'warning',
            confirmButtonText: 'حسناً'
        });
        return;
    }

    if (actionType === 'حذف' || actionType === 'حذف المحدد') {
        openDeleteModal(selectedIds);
    } else if (actionType === 'تغيير المستخدم') {
        const { value: newOwner } = await SafeSwal.fire({
            title: 'تغيير المستخدم',
            input: 'text',
            inputLabel: 'أدخل اسم المستخدم الجديد للمستندات المحددة (الظاهرة فقط):',
            showCancelButton: true,
            confirmButtonText: 'حفظ',
            cancelButtonText: 'إلغاء'
        });

        if (newOwner && newOwner.trim()) {
            try {
                if (db) {
                    const BATCH_SIZE = 400;
                    for (let i = 0; i < selectedIds.length; i += BATCH_SIZE) {
                        const chunk = selectedIds.slice(i, i + BATCH_SIZE);
                        const batch = writeBatch(db);
                        chunk.forEach(id => {
                            batch.update(doc(db, "visits", id), {
                                owner: newOwner.trim(),
                                editDate: getTodayFormatted()
                            });
                        });
                        await batch.commit();
                    }
                }

                selectedIds.forEach(id => {
                    const row = document.getElementById(id);
                    const vItem = visitsDataArray.find(v => v.id === id);
                    const oldOwner = vItem ? (vItem.owner || '') : (row?.querySelector('.owner-input')?.value || '');
                    const comp = vItem ? (vItem.comp || '') : (row?.querySelector('td.col-company input')?.value || '');
                    if (row) {
                        const ownerInput = row.querySelector('.owner-input');
                        if (ownerInput) {
                            ownerInput.value = newOwner.trim();
                            ownerInput.dataset.old = newOwner.trim();
                        }
                        updateEditDateField(row);
                    }
                    if (vItem) {
                        vItem.owner = newOwner.trim();
                        vItem.editDate = getTodayFormatted();
                    }
                    addToActivityLog('المستخدم', oldOwner, newOwner.trim(), comp, newOwner.trim());
                });

                try {
                    let localCache = JSON.parse(localStorage.getItem(VISITS_LOCAL_KEY) || '{}');
                    selectedIds.forEach(id => {
                        if (localCache[id]) {
                            localCache[id].owner = newOwner.trim();
                            localCache[id].editDate = getTodayFormatted();
                        }
                    });
                    localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(localCache));
                } catch(e){}

                updateDynamicOwnerFilter();
                SafeSwal.fire('تم التحديث', 'تم تغيير المستخدم بنجاح', 'success');
            } catch (e) {
                console.error("خطأ في تغيير المستخدم الجماعي:", e);
                SafeSwal.fire('خطأ', 'تعذر تغيير المستخدم', 'error');
            }
        }
    }
}

function openDeleteModal(ids) {
    itemsToDelete = Array.isArray(ids) ? ids : [ids];
    const modal = document.getElementById('deleteModal');
    const msg = document.getElementById('deleteModalMessage');
    if (msg) {
        msg.innerText = itemsToDelete.length > 1 
            ? `هل أنت متأكد من رغبتك في حذف ${itemsToDelete.length} عناصر محددة من الظاهرين؟`
            : `هل أنت متأكد من رغبتك في حذف هذا العنصر؟`;
    }
    if (modal) modal.style.display = 'flex';
}

function closeDeleteModal() {
    const modal = document.getElementById('deleteModal');
    if (modal) modal.style.display = 'none';
    itemsToDelete = [];
}

async function confirmDelete() {
    if (itemsToDelete.length === 0) return;
    try {
        const count = itemsToDelete.length;
        if (db) {
            const BATCH_SIZE = 400;
            for (let i = 0; i < itemsToDelete.length; i += BATCH_SIZE) {
                const chunk = itemsToDelete.slice(i, i + BATCH_SIZE);
                const batch = writeBatch(db);
                chunk.forEach(id => {
                    batch.delete(doc(db, "visits", id));
                });
                await batch.commit();
            }
        }

        try {
            let localCache = JSON.parse(localStorage.getItem(VISITS_LOCAL_KEY) || '{}');
            itemsToDelete.forEach(id => delete localCache[id]);
            localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(localCache));
        } catch(e){}

        visitsDataArray = visitsDataArray.filter(v => !itemsToDelete.includes(v.id));
        filterTable();

        closeDeleteModal();
        SafeSwal.fire('تم الحذف', 'تم حذف العناصر المحددة بنجاح', 'success');
    } catch(e) {
        console.error("خطأ أثناء الحذف:", e);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء الحذف', 'error');
    }
}

function openDatePicker(inputEl, rowId) {
    currentPickerInput = inputEl;
    currentPickerRowId = rowId;
    
    const val = inputEl.value;
    const parsed = parseDate(val);
    if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1970) {
        currentPickerMonth = parsed.getMonth();
        currentPickerYear = parsed.getFullYear();
    } else {
        const now = new Date();
        currentPickerMonth = now.getMonth();
        currentPickerYear = now.getFullYear();
    }
    
    renderDatePicker();
    const dp = document.getElementById('customDatePicker');
    if (dp) dp.classList.add('active');
}

function closeDatePicker() {
    const dp = document.getElementById('customDatePicker');
    if (dp) dp.classList.remove('active');
    currentPickerInput = null;
    currentPickerRowId = null;
}

function renderDatePicker() {
    const dpMonth = document.getElementById('dpMonth');
    const dpYear = document.getElementById('dpYear');
    if (!dpMonth || !dpYear) return;

    const monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    dpMonth.innerHTML = monthNames.map((m, idx) => `<option value="${idx}" ${idx === currentPickerMonth ? 'selected' : ''}>${m}</option>`).join('');
    
    const startYear = new Date().getFullYear() - 5;
    let yearOptions = '';
    for (let y = startYear; y <= startYear + 10; y++) {
        yearOptions += `<option value="${y}" ${y === currentPickerYear ? 'selected' : ''}>${y}</option>`;
    }
    dpYear.innerHTML = yearOptions;

    dpMonth.onchange = (e) => { currentPickerMonth = parseInt(e.target.value, 10); renderDatePickerDays(); };
    dpYear.onchange = (e) => { currentPickerYear = parseInt(e.target.value, 10); renderDatePickerDays(); };

    renderDatePickerDays();
}

function renderDatePickerDays() {
    const dpDays = document.getElementById('dpDays');
    if (!dpDays) return;
    dpDays.innerHTML = '';

    const firstDay = new Date(currentPickerYear, currentPickerMonth, 1).getDay();
    const totalDays = new Date(currentPickerYear, currentPickerMonth + 1, 0).getDate();
    const today = new Date();

    for (let i = 0; i < firstDay; i++) {
        const emptyDiv = document.createElement('div');
        dpDays.appendChild(emptyDiv);
    }

    for (let d = 1; d <= totalDays; d++) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'day-number';
        dayDiv.innerText = d;

        if (d === today.getDate() && currentPickerMonth === today.getMonth() && currentPickerYear === today.getFullYear()) {
            dayDiv.classList.add('today-day');
        }

        if (currentPickerInput) {
            const currentVal = parseDate(currentPickerInput.value);
            if (d === currentVal.getDate() && currentPickerMonth === currentVal.getMonth() && currentPickerYear === currentVal.getFullYear()) {
                dayDiv.classList.add('selected-day');
            }
        }

        dayDiv.onclick = () => selectDate(d, currentPickerMonth + 1, currentPickerYear);
        dpDays.appendChild(dayDiv);
    }
    enforceEnglishDigitsInDOM();
}

function selectDate(day, month, year) {
    const formatted = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
    if (currentPickerInput) {
        currentPickerInput.value = formatted;
        currentPickerInput.className = `excel-input readonly-input visit-date-val`;
    }
    if (currentPickerRowId) {
        const tr = document.getElementById(currentPickerRowId);
        if (tr) updateEditDateField(tr);
        saveSingleRow(currentPickerRowId);
    }
    closeDatePicker();
}

function setTodayDate() {
    const d = new Date();
    selectDate(d.getDate(), d.getMonth() + 1, d.getFullYear());
}

function initServiceHoverTooltip() {
    let tooltip = document.getElementById('visitsServiceTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'visitsServiceTooltip';
        tooltip.className = 'visits-service-popover';
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
        const cell = target.closest('.col-service, td.col-service');
        if (!cell) return;
        const mainRow = cell.closest('tr.main-row');
        if (!mainRow) return;

        activeCell = cell;
        const input = cell.querySelector('.cur-serv-val') || cell.querySelector('input');
        const text = input ? input.value.trim() : cell.innerText.trim();
        const compInput = mainRow.querySelector('td.col-company input');
        const compName = compInput ? compInput.value.trim() : '';

        let contentHtml = '';
        const headerTitle = compName ? `خدمة: ${escapeHTML(compName)}` : 'تفاصيل الخدمة';
        if (text) {
            contentHtml = `<div class="popover-header"><i class="fas fa-concierge-bell"></i> ${headerTitle}</div><div class="popover-body">${escapeHTML(text)}</div>`;
        } else {
            contentHtml = `<div class="popover-header"><i class="fas fa-concierge-bell"></i> ${headerTitle}</div><div class="popover-body empty"><i class="fas fa-info-circle"></i> لا توجد خدمة مدونة</div>`;
        }

        tooltip.innerHTML = contentHtml;
        tooltip.classList.add('visible');
        updateTooltipPosition(cell);
    }

    function hideTooltip() {
        activeCell = null;
        tooltip.classList.remove('visible');
    }

    const table = document.getElementById('mainTable');
    if (table) {
        table.addEventListener('mouseover', (e) => {
            const cell = e.target.closest('.col-service, td.col-service');
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
            if (e.target && e.target.classList.contains('cur-serv-val') && activeCell && activeCell.contains(e.target)) {
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

window.insertNewRow = insertNewRow;
window.addToActivityLog = addToActivityLog;
window.handleVisitFieldBlur = handleVisitFieldBlur;
window.debouncedFilterTable = debouncedFilterTable;
window.toggleCustomFilter = toggleCustomFilter;
window.updateFilters = updateFilters;
window.selectAllFilter = selectAllFilter;
window.clearAllFilter = clearAllFilter;
window.openNote = openNote;
window.saveNote = saveNote;
window.closeNote = closeNote;
window.deleteNote = deleteNote;
window.toggleSubTable = toggleSubTable;
window.addProductRow = addProductRow;
window.removeProductRow = removeProductRow;
window.updateProductTotal = updateProductTotal;
window.recalculateAndSaveProducts = recalculateAndSaveProducts;
window.debouncedSaveRow = debouncedSaveRow;
window.onStatusChange = onStatusChange;
window.toggleLogExpansion = toggleLogExpansion;
window.toggleDropdown = toggleDropdown;
window.handleBulkAction = handleBulkAction;
window.handleImportExcel = handleImportExcel;
window.toggleAllCheckboxes = toggleAllCheckboxes;
window.updateMasterCheckboxState = updateMasterCheckboxState;
window.openDeleteModal = openDeleteModal;
window.closeDeleteModal = closeDeleteModal;
window.confirmDelete = confirmDelete;
window.openDatePicker = openDatePicker;
window.closeDatePicker = closeDatePicker;
window.selectDate = selectDate;
window.setTodayDate = setTodayDate;
window.filterTable = filterTable;
window.renderRowHTML = renderRowHTML;
window.sanitizeMobileInput = sanitizeMobileInput;
window.handleMobilePaste = handleMobilePaste;
window.parseEditDateHTML = parseEditDateHTML;
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
    localStorage.setItem('asgate_visits_stats_hidden', isHidden ? 'true' : 'false');
}

function initStatsVisibility() {
    const isHidden = localStorage.getItem('asgate_visits_stats_hidden') === 'true';
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

window.toggleStatsVisibility = toggleStatsVisibility;
window.initStatsVisibility = initStatsVisibility;
window.getEyeHideIconSvg = getEyeHideIconSvg;
window.getEyeShowIconSvg = getEyeShowIconSvg;

window.getVisitsDebug = () => ({
    visitsCount: visitsDataArray.length,
    query: document.getElementById('searchInput')?.value,
    statusCount: totalStatusOptionsCount,
    activeStatus: activeStatusFilters,
    ownerCount: totalOwnerOptionsCount,
    activeOwner: activeOwnerFilters,
    sampleItem: visitsDataArray[0]
});
window.initServiceHoverTooltip = initServiceHoverTooltip;

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

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { listenToVisits(); markPageReady(); initServiceHoverTooltip(); initStatsVisibility(); checkUrlHighlight(); });
} else {
    listenToVisits();
    markPageReady();
    initServiceHoverTooltip();
    initStatsVisibility();
    checkUrlHighlight();
}
