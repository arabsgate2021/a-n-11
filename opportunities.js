// =========================================================================
// opportunities.js - إدارة الفرص البيعية سحابياً ومحلياً (نظام ASGate CRM)
// استراتيجية ترشيد الكوتا (Zero-Waste Firebase Quota):
// 1. قراءة فورية من الكاش المحلي (asgate_opportunities_local_cache_v1)
// 2. تحديث فوري للكاش المحلي مع تأخير (Debounce) إرسال التعديلات لفايربيز
// 3. ربط الفرصة بالعميل وسجل الأنشطة برقم السجل التجاري وليس الاسم
// =========================================================================

import Swal from 'sweetalert2';
import * as XLSX from 'xlsx';
window.Swal = Swal;
window.XLSX = XLSX;

import { db, collection, onSnapshot, doc, setDoc, deleteDoc, getDocs, writeBatch } from './firebase-config.js';
import { isCustomerMatchedByCr, createActivityLogEntry, renderActivityLogsHTML } from './src/crm_logic.js';

let saveTimeouts = {}; 
let searchTimeout;
let initialScrollDone = false;
let userHasManuallyScrolled = false;
let lastRenderedSignature = '';
const LOGS_KEY = 'asgate_opportunities_activity_logs_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

function computeOpportunitiesSignature(items) {
    try {
        const arr = Array.isArray(items) ? items : Object.values(items || {});
        const normalized = arr.map(it => ({
            id: String(it.id || ''),
            comp: String(it.comp || ''),
            address: String(it.address || ''),
            mgr: String(it.mgr || ''),
            mob: String(it.mob || ''),
            email: String(it.email || ''),
            record: String(it.record || ''),
            oppDate: String(it.oppDate || it.visitDate || ''),
            curServ: String(it.curServ || ''),
            oppValue: String(it.oppValue || ''),
            notes: String(it.notes || '[]'),
            status: String(it.status || ''),
            expDate: String(it.expDate || ''),
            editDate: String(it.editDate || ''),
            owner: String(it.owner || ''),
            products: Array.isArray(it.products) ? it.products : []
        })).sort((a, b) => a.id.localeCompare(b.id));
        return JSON.stringify(normalized);
    } catch (e) {
        return '';
    }
}

let logsDataList = [];
let activeStatusFilters = ['مهتم', 'رابح', 'فقدان'];
let totalStatusOptionsCount = 3;
let activeOwnerFilters = [];
let totalOwnerOptionsCount = 0;
let isOwnerFilterInitialized = false;

let currentCalendarTarget = null;
let currentCalendarRowId = null;
let calendarCurrentDate = new Date();
let currentNotePreviewEl = null;

function escapeHTML(str) { 
    if (typeof str !== 'string') return '';
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])); 
}
function safe(value, fallback = '-') { 
    const v = value && String(value).trim() ? String(value).trim() : fallback;
    return escapeHTML(v);
}
function sanitizeId(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}
function generateRowId() {
    const rand = Math.random().toString(36).substring(2,8);
    return 'row-' + Date.now().toString(36) + '-' + rand;
}
function getTodayFormatted() { 
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
} 
function getTimeFormatted() { 
    const d = new Date(); 
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0'); 
} 
function formatDateToDisplay(dateStr) {
    if (!dateStr) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y,m,day] = dateStr.split('-');
        return `${day}-${m}-${y}`;
    }
    return dateStr;
}
function parseDateLocal(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [y,m,d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m-1, d);
    return isNaN(dt.getTime()) ? null : dt;
}

function isRowVisible(row) {
    if (!row) return false;
    if (row.style.display === 'none') return false;
    if (row.classList.contains('hidden')) return false;
    if (row.offsetParent === null && window.getComputedStyle(row).display === 'none') return false;
    return true;
}
window.isRowVisible = isRowVisible;

function updateMasterCheckboxState() {
    const masterCb = document.getElementById('masterCheckbox') || document.querySelector('thead th.col-select input[type="checkbox"]');
    if (!masterCb) return;

    const visibleRows = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(isRowVisible);
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
window.updateMasterCheckboxState = updateMasterCheckboxState;

function toggleAllCheckboxes(master) {
    const isChecked = !!(master && master.checked);
    const rows = document.querySelectorAll('#tableBody .main-row');
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
window.toggleAllCheckboxes = toggleAllCheckboxes;

function saveLogsLocalBackup() {
    try { localStorage.setItem(LOGS_KEY, JSON.stringify(logsDataList)); } 
    catch (e) { console.error("Local Storage Logs error:", e); }
}

async function loadLogsData() {
    try {
        const localLogs = localStorage.getItem(LOGS_KEY);
        if (localLogs) { logsDataList = JSON.parse(localLogs); renderLogs(logsDataList); }
    } catch(e){}
    try {
        if (db) {
            onSnapshot(collection(db, "opportunities_activity_logs"), (logsSnapshot) => {
                const freshLogs = [];
                logsSnapshot.forEach((docSnap) => { freshLogs.push(docSnap.data()); });
                freshLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                if (freshLogs.length > 0) {
                    logsDataList = freshLogs.slice(0, 100);
                    saveLogsLocalBackup();
                    renderLogs(logsDataList);
                }
            }, (err) => {
                console.warn("Notice: Cloud logs snapshot fallback:", err);
            });
        }
    } catch (error) { console.warn("Notice: Operating with local logs cache:", error); }
}

function renderLogs(list) {
    const logsBody = document.getElementById('activityList');
    if (!logsBody) return;
    logsBody.innerHTML = renderActivityLogsHTML(list, 'opportunities');
}

async function addToActivityLog(fieldName, oldVal, newVal, companyName, ownerName) { 
    const logEntry = createActivityLogEntry({
        page: 'opportunities',
        fieldName,
        oldVal,
        newVal,
        identifierValue: companyName,
        user: ownerName
    });
    if (!logEntry) return;
    logsDataList.unshift(logEntry);
    logsDataList = logsDataList.slice(0, 100); 
    saveLogsLocalBackup();
    renderLogs(logsDataList);
    try { 
        if (db) await setDoc(doc(db, "opportunities_activity_logs", logEntry.timestamp.toString()), logEntry); 
    } catch (e) { console.warn("إشعار حفظ سجل النشاط سحابياً:", e); }
}
window.addToActivityLog = addToActivityLog; 

function collectRowData(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return null;
    const subRow = document.getElementById('sub-' + rowId);
    const products = [];
    if (subRow) {
        subRow.querySelectorAll('.product-body tr').forEach(pRow => {
            const inputs = pRow.querySelectorAll('input, select');
            if (inputs.length >= 5) products.push({ type: inputs[0].value, desc: inputs[1].value, qty: inputs[2].value, sub: inputs[3].value, total: inputs[4].value });
        });
    }
    return {
        id: rowId,
        comp: row.cells[1]?.querySelector('input')?.value || '',
        address: row.cells[2]?.querySelector('input')?.value || '',
        mgr: row.cells[3]?.querySelector('input')?.value || '',
        mob: row.cells[4]?.querySelector('input')?.value || '',
        email: row.cells[5]?.querySelector('input')?.value || '',
        record: row.cells[6]?.querySelector('input')?.value || '',
        oppDate: row.querySelector('.opp-date-val')?.value || '',
        curServ: row.cells[8]?.querySelector('input')?.value || '',
        oppValue: row.cells[9]?.querySelector('.opp-value-input')?.value || '',
        notes: row.cells[10]?.querySelector('.notes-preview')?.dataset.fullNotes || '[]',
        status: row.cells[11]?.querySelector('select')?.value || '',
        expDate: row.cells[12]?.querySelector('.exp-date-input')?.value || '',
        editDate: row.querySelector('.edit-date-val')?.value || getTodayFormatted(),
        owner: row.cells[13]?.querySelector('input')?.value || '',
        products
    };
}

function saveRowLocally(rowId) {
    const data = collectRowData(rowId);
    if (!data) return;
    try {
        let raw = localStorage.getItem(OPP_LOCAL_KEY);
        let localCache = {};
        if (raw) {
            const parsed = JSON.parse(raw);
            localCache = Array.isArray(parsed) ? {} : parsed;
        }
        localCache[rowId] = data;
        localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
        lastRenderedSignature = computeOpportunitiesSignature(localCache);

        // ربط نشاط الفرصة بالعميل وسجل الأنشطة برقم السجل التجاري وليس الاسم
        let rawCusts = localStorage.getItem('crm_customers');
        if (rawCusts) {
            let custs = JSON.parse(rawCusts);
            let custChanged = false;
            const nowIso = new Date().toISOString();
            custs.forEach(c => {
                if (isCustomerMatchedByCr(c, data)) {
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
    } catch (e) { console.error("خطأ حفظ محلي للفرصة:", e); }
}

const DEFAULT_SAMPLE_OPPORTUNITIES = [
    {
        id: "opp_001", comp: "شركة الأفق للحلول الرقمية", address: "الرياض - الصحافة", mgr: "فهد العتيبي",
        mob: "0501234567", email: "info@alofooq.sa", record: "1010345678", oppDate: "2026-10-10",
        curServ: "سنترال سحابي", oppValue: "15000", notes: "[]", status: "مهتم", expDate: "2026-10-25",
        editDate: "2026-10-15", owner: "أحمد الحربي",
        products: [{ type: "DIA", desc: "خط اتصال فائق السرعة", qty: "1", sub: "15000", total: "15000" }]
    },
    {
        id: "opp_002", comp: "مجموعة البناء الحديث", address: "الدمام - الشاطئ", mgr: "م. حسام الزهراني",
        mob: "0564567890", email: "husam@modernbuild.com", record: "2050987654", oppDate: "2026-10-05",
        curServ: "ربط فروع IPVPN", oppValue: "28000", notes: "[]", status: "رابح", expDate: "2026-10-18",
        editDate: "2026-10-15", owner: "خالد الشمري",
        products: [{ type: "IPVPN", desc: "ربط 4 مواقع", qty: "4", sub: "7000", total: "28000" }]
    },
    {
        id: "opp_003", comp: "مستشفى الرعاية المتقدمة", address: "جدة - الحمراء", mgr: "د. طارق الغامدي",
        mob: "0552345678", email: "tariq@care.med", record: "4030112233", oppDate: "2026-09-20",
        curServ: "فايبر نت أعمال", oppValue: "9500", notes: "[]", status: "فقدان", expDate: "2026-09-30",
        editDate: "2026-10-12", owner: "محمد القحطاني",
        products: [{ type: "فايبر نت", desc: "سرعة 500 ميجا", qty: "1", sub: "9500", total: "9500" }]
    },
    {
        id: "opp_004", comp: "شركة الرواد للتقنية", address: "الرياض - العليا", mgr: "سارة العتيبي",
        mob: "0541122334", email: "sara@alrowad.sa", record: "1010998877", oppDate: "2026-10-12",
        curServ: "SIP Trunk", oppValue: "6000", notes: "[]", status: "مهتم", expDate: "2026-10-28",
        editDate: "2026-10-15", owner: "أحمد الحربي",
        products: [{ type: "SIP", desc: "30 قناة اتصال", qty: "1", sub: "6000", total: "6000" }]
    },
    {
        id: "opp_005", comp: "مؤسسة الابتكار للتجارة", address: "المدينة - قباء", mgr: "صالح المولد",
        mob: "0575678901", email: "saleh@ebtekar.com", record: "4650334455", oppDate: "2026-10-01",
        curServ: "بيانات وشريحة أعمال", oppValue: "3500", notes: "[]", status: "مهتم", expDate: "2026-10-22",
        editDate: "2026-10-14", owner: "سارة العتيبي",
        products: [{ type: "بيانات", desc: "شرائح 5G للأجهزة", qty: "5", sub: "700", total: "3500" }]
    }
];

function listenToOpportunities() {
    try {
        let raw = localStorage.getItem(OPP_LOCAL_KEY);
        let items = [];
        if (raw) {
            const parsed = JSON.parse(raw);
            items = Array.isArray(parsed) ? parsed : Object.values(parsed);
        }
        if (items.length === 0) {
            items = DEFAULT_SAMPLE_OPPORTUNITIES;
            let initCache = {};
            items.forEach(it => { initCache[it.id] = it; });
            try { localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(initCache)); } catch(e){}
        }
        const tbody = document.getElementById('tableBody');
        if (tbody && tbody.children.length === 0) {
            items.forEach(d => renderRow(d, false));
            lastRenderedSignature = computeOpportunitiesSignature(items);
            populateFilterDropdowns();
            filterTable();
            scrollToCurrentMonthSeparator();
        }
    } catch(e) {}

    if (!db) return;

    try {
        const oppsRef = collection(db, "opportunities");
        onSnapshot(oppsRef, (snapshot) => {
            const tbody = document.getElementById('tableBody');
            if (!tbody) return;

            let incomingItems = [];
            let batchCache = {};
            if (!snapshot.empty) {
                snapshot.forEach((docSnapshot) => {
                    const data = docSnapshot.data();
                    data.id = docSnapshot.id;
                    const item = { ...data, id: data.id };
                    incomingItems.push(item);
                    batchCache[data.id] = item;
                });
                try { localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(batchCache)); } catch(e){}
            } else {
                try {
                    let raw = localStorage.getItem(OPP_LOCAL_KEY);
                    if (raw) {
                        const parsed = JSON.parse(raw);
                        incomingItems = Array.isArray(parsed) ? parsed : Object.values(parsed);
                    }
                    if (incomingItems.length === 0) incomingItems = DEFAULT_SAMPLE_OPPORTUNITIES;
                } catch(e) { console.error("قراءة محلي:", e); }
            }

            const newSignature = computeOpportunitiesSignature(incomingItems);
            if (tbody.querySelectorAll('.main-row').length > 0 && newSignature && newSignature === lastRenderedSignature) {
                if (!initialScrollDone) {
                    scrollToCurrentMonthSeparator();
                }
                return;
            }
            lastRenderedSignature = newSignature;

            const wrapper = document.querySelector('.table-wrapper');
            const prevScrollTop = wrapper ? wrapper.scrollTop : 0;
            if (wrapper) wrapper.style.scrollBehavior = 'auto';

            let openSubTables = [];
            document.querySelectorAll('.sub-table-row').forEach(row => {
                if (row.style.display === 'table-row') openSubTables.push(row.id);
            });

            let activeInfo = null;
            if (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) {
                const tr = document.activeElement.closest('tr.main-row');
                if (tr) {
                    activeInfo = {
                        id: tr.id,
                        tag: document.activeElement.tagName,
                        className: document.activeElement.className,
                        value: document.activeElement.value,
                        selStart: null
                    };
                    try { activeInfo.selStart = document.activeElement.selectionStart; } catch(e){}
                    const allSame = tr.querySelectorAll(`${activeInfo.tag}.${activeInfo.className.split(' ')[0]}`);
                    activeInfo.index = Array.from(allSame).indexOf(document.activeElement);
                }
            }

            tbody.innerHTML = '';
            incomingItems.forEach(d => renderRow(d, false));
            
            populateFilterDropdowns();
            filterTable();

            openSubTables.forEach(id => {
                const sub = document.getElementById(id);
                if (sub) {
                    sub.style.display = 'table-row';
                    const mainId = id.replace('sub-', '');
                    const main = document.getElementById(mainId);
                    if (main) {
                        const arrow = main.querySelector('.toggle-arrow i');
                        if (arrow) arrow.className = 'fas fa-caret-down';
                        main.querySelector('.toggle-arrow')?.classList.add('arrow-open');
                    }
                }
            });

            if (activeInfo) {
                const activeRow = document.getElementById(activeInfo.id);
                if (activeRow) {
                    const candidates = activeRow.querySelectorAll(`${activeInfo.tag}.${activeInfo.className.split(' ')[0]}`);
                    const elToFocus = candidates[activeInfo.index] || candidates[0];
                    if (elToFocus) {
                        elToFocus.focus();
                        try { if (activeInfo.selStart !== null) elToFocus.setSelectionRange(activeInfo.selStart, activeInfo.selStart); } catch(e){}
                    }
                }
                if (wrapper) wrapper.scrollTop = prevScrollTop;
            } else if (!userHasManuallyScrolled) {
                scrollToCurrentMonthSeparator();
            } else if (wrapper) {
                wrapper.scrollTop = prevScrollTop;
            }
        }, (err) => { 
            console.warn("onSnapshot notice (local fallback):", err);
        });
    } catch(err) {
        console.warn("Local mode active for opportunities:", err);
    }
}

function renderRow(v = {}, prepend = false) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rawId = v.id || generateRowId();
    const rowId = sanitizeId(rawId);
    
    const mainRow = document.createElement('tr');
    mainRow.className = 'main-row';
    mainRow.id = rowId;
    mainRow.dataset.firestoreId = rawId;
    
    const subRow = document.createElement('tr');
    subRow.className = 'sub-table-row';
    subRow.id = 'sub-' + rowId;
    subRow.style.display = 'none';
    
    const oppDate = v.oppDate || v.visitDate || getTodayFormatted(); 
    const notesJson = v.notes || "[]";
    const lastNoteText = getLastNoteOnlyFromJSON(notesJson);

    const td0 = document.createElement('td');
    td0.className = 'col-select';
    const chk = document.createElement('input');
    chk.type = 'checkbox'; 
    chk.className = 'select-check';
    chk.addEventListener('change', updateMasterCheckboxState);

    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'toggle-arrow';
    arrowSpan.innerHTML = '<i class="fas fa-caret-left"></i>';
    arrowSpan.addEventListener('click', ()=> toggleSubTable(rowId));
    td0.append(chk, arrowSpan);

    const makeCell = (fieldKey, value, fieldLabel, colClass = '') => {
        const td = document.createElement('td');
        if (colClass) td.className = colClass;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'excel-input' + (colClass === 'col-service' ? ' cur-serv-val' : '');
        inp.value = value || '';
        inp.dataset.old = value || '';
        inp.addEventListener('focus', function(){ this.dataset.old = this.value; });
        inp.addEventListener('keyup', function(){ updateEditDateField(this.closest('tr')); debouncedSaveSingleRow(rowId); });
        inp.addEventListener('blur', function(){
            const comp = this.closest('tr').cells[1]?.querySelector('input')?.value || '';
            const owner = this.closest('tr').cells[13]?.querySelector('input')?.value || '';
            addToActivityLog(fieldLabel, this.dataset.old, this.value, comp, owner);
            this.dataset.old = this.value;
        });
        td.appendChild(inp);
        return td;
    };

    const td1 = makeCell('comp', v.comp || '', 'الشركة', 'col-company');
    const td2 = makeCell('address', v.address || '', 'العنوان', 'col-address');
    const td3 = makeCell('mgr', v.mgr || '', 'المسؤول', 'col-manager');

    const td4 = document.createElement('td');
    td4.className = 'col-mobile';
    const mobWrap = document.createElement('div');
    mobWrap.style.display='flex'; mobWrap.style.alignItems='center'; mobWrap.style.gap='4px';
    const mobInput = document.createElement('input');
    mobInput.type='text'; mobInput.className='excel-input'; mobInput.value = v.mob || ''; mobInput.dataset.old = v.mob || '';
    mobInput.addEventListener('focus', function(){ this.dataset.old=this.value; });
    mobInput.addEventListener('keydown', function(e) {
        if (e.key === ' ' || e.code === 'Space') {
            e.preventDefault();
        }
    });
    mobInput.addEventListener('input', function() {
        this.value = this.value.replace(/[\s\u200B-\u200D\uFEFF]/g, '').replace(/[^0-9+]/g, '');
        debouncedSaveSingleRow(rowId);
    });
    mobInput.addEventListener('paste', function(e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text') || '';
        const clean = text.replace(/[\s\u200B-\u200D\uFEFF]/g, '').replace(/[^0-9+]/g, '');
        document.execCommand('insertText', false, clean);
    });
    mobInput.addEventListener('keyup', function(){ updateEditDateField(this.closest('tr')); debouncedSaveSingleRow(rowId); });
    mobInput.addEventListener('blur', function(){
        const comp = this.closest('tr').cells[1]?.querySelector('input')?.value || '';
        const owner = this.closest('tr').cells[13]?.querySelector('input')?.value || '';
        addToActivityLog('رقم التواصل', this.dataset.old, this.value, comp, owner);
        this.dataset.old=this.value;
    });
    mobWrap.appendChild(mobInput);
    if (v.mob) {
        const wa = document.createElement('a');
        wa.href = `https://wa.me/${String(v.mob).replace(/[^0-9]/g,'')}`;
        wa.target = '_blank'; wa.className = 'whatsapp-icon-btn'; wa.title='واتساب';
        wa.innerHTML = '<i class="fab fa-whatsapp"></i>';
        mobWrap.appendChild(wa);
    }
    td4.appendChild(mobWrap);

    const td5 = makeCell('email', v.email || '', 'البريد الالكتروني', 'col-email');

    const td6 = document.createElement('td');
    td6.className = 'col-record';
    const recInp = document.createElement('input');
    recInp.type='text'; recInp.className='excel-input'; recInp.value = v.record || ''; recInp.dataset.old = v.record || '';
    recInp.addEventListener('input', function(){ this.value = this.value.replace(/[^0-9]/g,''); debouncedSaveSingleRow(rowId); });
    recInp.addEventListener('focus', function(){ this.dataset.old=this.value; });
    recInp.addEventListener('keyup', function(){ updateEditDateField(this.closest('tr')); });
    recInp.addEventListener('blur', function(){
        const comp = this.closest('tr').cells[1]?.querySelector('input')?.value || '';
        const owner = this.closest('tr').cells[13]?.querySelector('input')?.value || '';
        addToActivityLog('السجل التجاري', this.dataset.old, this.value, comp, owner);
        this.dataset.old=this.value;
    });
    td6.appendChild(recInp);

    const td7 = document.createElement('td');
    td7.className = 'col-date';
    const oppDisp = document.createElement('input');
    oppDisp.type='text'; oppDisp.className='excel-input readonly-input';
    oppDisp.value = formatDateToDisplay(oppDate); oppDisp.readOnly=true;
    oppDisp.style.color='var(--text-muted)'; oppDisp.style.fontWeight='700';
    const oppHidden = document.createElement('input');
    oppHidden.type='hidden'; oppHidden.className='opp-date-val'; oppHidden.value = oppDate;
    td7.append(oppDisp, oppHidden);

    const td8 = makeCell('curServ', v.curServ || '', 'الخدمة', 'col-service');
    
    const td9 = document.createElement('td');
    td9.className = 'col-val';
    const valInp = document.createElement('input');
    valInp.type='number'; valInp.className='excel-input opp-value-input readonly-input';
    valInp.value = v.oppValue || ''; valInp.readOnly=true;
    valInp.style.color='var(--accent-blue)'; valInp.style.fontWeight='800'; valInp.style.cursor='not-allowed';
    valInp.style.background='transparent';
    td9.appendChild(valInp);

    const td10 = document.createElement('td');
    td10.className = 'col-notes';
    const notesDiv = document.createElement('div');
    notesDiv.className='notes-preview';
    notesDiv.dataset.fullNotes = notesJson;
    notesDiv.textContent = lastNoteText || '';
    if (!lastNoteText) notesDiv.innerHTML = '<span style="color:#94a3b8">بدون ملاحظات</span>';
    notesDiv.addEventListener('click', function(){ openNote(this); });
    td10.appendChild(notesDiv);

    const td11 = document.createElement('td');
    td11.className = 'col-status';
    const statusSel = document.createElement('select');
    statusSel.className='excel-input status-select';
    statusSel.dataset.old = v.status || '';
    ['','مهتم','رابح','فقدان'].forEach(optVal=>{
        const o = document.createElement('option');
        if (optVal==='') { o.value=''; o.textContent='اختر...'; o.disabled=true; if (!v.status) o.selected=true; }
        else { o.value=optVal; o.textContent=optVal; if (v.status===optVal) o.selected=true; }
        statusSel.appendChild(o);
    });
    statusSel.addEventListener('focus', function(){ this.dataset.old=this.value; });
    statusSel.addEventListener('change', function(){ handleStatusChange(this, rowId); });
    td11.appendChild(statusSel);

    const td12 = document.createElement('td');
    td12.className = 'col-edit';
    const expDisp = document.createElement('input');
    expDisp.type='text'; expDisp.className='excel-input exp-date-input-display readonly-input';
    expDisp.value = formatDateToDisplay(v.expDate || ''); expDisp.readOnly=true; expDisp.style.cursor='pointer';
    expDisp.placeholder='اختر التاريخ';
    expDisp.addEventListener('click', (e)=> openCustomDatePicker(e, expDisp, rowId));
    const expHidden = document.createElement('input');
    expHidden.type='hidden'; expHidden.className='exp-date-input'; expHidden.value=v.expDate||''; expHidden.dataset.old=v.expDate||'';
    const editHidden = document.createElement('input');
    editHidden.type='hidden'; editHidden.className='edit-date-val'; editHidden.value=v.editDate||'';
    td12.append(expDisp, expHidden, editHidden);

    const td13 = makeCell('owner', v.owner || '', 'المستخدم', 'col-owner');

    [td0,td1,td2,td3,td4,td5,td6,td7,td8,td9,td10,td11,td12,td13].forEach(td=> mainRow.appendChild(td));

    subRow.innerHTML = `
        <td colspan="14">
            <div class="sub-table-container" style="display:flex; gap:12px;">
                <div class="sub-table-wrapper" style="flex:1;">
                    <table class="inner-table" style="width: 100%;">
                        <thead>
                            <tr>
                                <th>المنتج</th><th>التفاصيل</th><th>العدد</th><th>الاشتراك</th><th>الإجمالي</th>
                                <th style="width:75px"><button type="button" class="header-plus-btn" title="إضافة منتج"><i class="fas fa-plus"></i></button></th>
                            </tr>
                        </thead>
                        <tbody class="product-body"></tbody>
                    </table>
                </div>
                <div style="width: 250px; background: white; border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; justify-content: center; align-items: center; box-shadow: 0 4px 6px rgba(0,0,0,.05);">
                    <div style="font-weight:bold; color:#2e1065; margin-bottom:10px; font-size:12px;">تفاصيل التعديل والوقت:</div>
                    <div class="edit-date-container-sub" style="display:flex; flex-direction:column; align-items:center;">${parseEditDateHTML(v.editDate || '')}</div>
                </div>
            </div>
        </td>`;
    const plusBtn = subRow.querySelector('.header-plus-btn');
    if (plusBtn) plusBtn.addEventListener('click', ()=> addProductRow(rowId));

    if (prepend && tbody.firstChild) {
        tbody.insertBefore(subRow, tbody.firstChild);
        tbody.insertBefore(mainRow, subRow);
    } else {
        tbody.appendChild(mainRow); 
        tbody.appendChild(subRow); 
    }
    applyStatusColor(mainRow.querySelector('.status-select'));
    if (v.products && v.products.length > 0) v.products.forEach(p => addProductRow(rowId, p)); else addProductRow(rowId);
    calculateMainVisitValue(rowId, false);
}

function addProductRow(rowId, data = {}) {
    const subRow = document.getElementById('sub-' + rowId);
    if (!subRow) return;
    const tbody = subRow.querySelector('.product-body');
    const row = tbody.insertRow();
    const typeSel = document.createElement('select');
    ['','جوال','بيانات','هاتف','فايبر نت','DIA','IPVPN','SIP'].forEach(val=>{
        const o=document.createElement('option'); o.value=val; o.textContent=val||'-'; if (data.type===val) o.selected=true; typeSel.appendChild(o);
    });
    typeSel.addEventListener('change', function(){ updateEditDateField(this.closest('.sub-table-row').previousElementSibling); debouncedSaveSingleRow(rowId); });

    const descInp = document.createElement('input'); descInp.type='text'; descInp.value=data.desc||''; descInp.addEventListener('keyup', function(){ updateEditDateField(this.closest('.sub-table-row').previousElementSibling); debouncedSaveSingleRow(rowId); });

    const qtyInp = document.createElement('input'); qtyInp.type='number'; qtyInp.className='prod-qty'; qtyInp.min='0'; qtyInp.value=data.qty||'';
    qtyInp.addEventListener('keyup', function(){ updateEditDateField(this.closest('.sub-table-row').previousElementSibling); calculateMainVisitValue(rowId); });
    qtyInp.addEventListener('input', function(){ calculateMainVisitValue(rowId); });

    const subInp = document.createElement('input'); subInp.type='number'; subInp.className='prod-sub'; subInp.min='0'; subInp.value=data.sub||'';
    subInp.addEventListener('keyup', function(){ updateEditDateField(this.closest('.sub-table-row').previousElementSibling); calculateMainVisitValue(rowId); });
    subInp.addEventListener('input', function(){ calculateMainVisitValue(rowId); });

    const totalInp = document.createElement('input'); totalInp.type='number'; totalInp.className='prod-total readonly-input'; totalInp.readOnly=true; totalInp.value=data.total||''; totalInp.style.color='var(--text-muted)'; totalInp.style.fontWeight='700'; totalInp.style.cursor='not-allowed';

    const delBtn = document.createElement('button'); delBtn.className='sub-action-btn'; delBtn.title='حذف'; delBtn.innerHTML='<i class="fas fa-trash-alt" style="font-size:10px;"></i>';
    delBtn.addEventListener('click', function(){
        if (this.closest('tbody').rows.length>1) {
            const main = this.closest('.sub-table-row').previousElementSibling;
            updateEditDateField(main);
            this.closest('tr').remove();
            calculateMainVisitValue(rowId);
        }
    });

    const c0=document.createElement('td'); c0.appendChild(typeSel);
    const c1=document.createElement('td'); c1.appendChild(descInp);
    const c2=document.createElement('td'); c2.appendChild(qtyInp);
    const c3=document.createElement('td'); c3.appendChild(subInp);
    const c4=document.createElement('td'); c4.appendChild(totalInp);
    const c5=document.createElement('td'); const wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.justifyContent='center'; wrap.appendChild(delBtn); c5.appendChild(wrap);
    row.append(c0,c1,c2,c3,c4,c5);
}
window.addProductRow = addProductRow; 

function calculateMainVisitValue(rowId, shouldSave = true) {
    const subRow = document.getElementById('sub-' + rowId);
    if (!subRow) return;
    let grandTotal = 0;
    subRow.querySelectorAll('.product-body tr').forEach(pRow => {
        const qty = parseFloat(pRow.querySelector('.prod-qty').value) || 0;
        const sub = parseFloat(pRow.querySelector('.prod-sub').value) || 0;
        const rowTotal = qty * sub;
        pRow.querySelector('.prod-total').value = rowTotal > 0 ? rowTotal : '';
        grandTotal += rowTotal;
    });
    const mainRow = document.getElementById(rowId);
    if (mainRow) {
        const oppVal = mainRow.querySelector('.opp-value-input');
        if (oppVal) oppVal.value = grandTotal > 0 ? grandTotal : '';
    }
    if (shouldSave) debouncedSaveSingleRow(rowId);
}
window.calculateMainVisitValue = calculateMainVisitValue; 

async function saveSingleRow(rowId) {
    const data = collectRowData(rowId);
    if (!data) return;
    const firestoreId = document.getElementById(rowId)?.dataset.firestoreId || rowId;
    const { id, ...payload } = data;
    try {
        if (db) await setDoc(doc(db, "opportunities", firestoreId), payload, { merge: true });
        updateStats();
        populateFilterDropdowns();
    } catch (e) { console.warn("خطأ حفظ سحابي للفرصة:", e); }
}
function debouncedSaveSingleRow(rowId) {
    saveRowLocally(rowId);
    if (saveTimeouts[rowId]) clearTimeout(saveTimeouts[rowId]);
    saveTimeouts[rowId] = setTimeout(() => { saveSingleRow(rowId); delete saveTimeouts[rowId]; }, 900);
}
window.debouncedSaveSingleRow = debouncedSaveSingleRow; 

function toggleDropdown(event, btn) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('bulkActionMenu');
    if (!menu) return;
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    menu.classList.toggle('show');
}
window.toggleDropdown = toggleDropdown;

function toggleCustomFilter(event, menuId) {
    if (event) event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    if (!isShown) menu.classList.add('show');
}
window.toggleCustomFilter = toggleCustomFilter;

function selectAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    updateFilters();
}
window.selectAllFilter = selectAllFilter;

function clearAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateFilters();
}
window.clearAllFilter = clearAllFilter;

function updateFilters() {
    const statusCbs = document.querySelectorAll('#statusFilterMenu input[type="checkbox"]');
    totalStatusOptionsCount = statusCbs.length || 3;
    activeStatusFilters = Array.from(document.querySelectorAll('#statusFilterMenu input[type="checkbox"]:checked')).map(cb => cb.value);

    const ownerCbs = document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]');
    totalOwnerOptionsCount = ownerCbs.length;
    activeOwnerFilters = Array.from(document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]:checked')).map(cb => cb.value);

    const statusDot = document.getElementById('statusFilterDot');
    const ownerDot = document.getElementById('ownerFilterDot');
    if (statusDot) {
        statusDot.style.display = (activeStatusFilters.length < totalStatusOptionsCount) ? 'inline-block' : 'none';
    }
    if (ownerDot) {
        ownerDot.style.display = (activeOwnerFilters.length < totalOwnerOptionsCount) ? 'inline-block' : 'none';
    }

    filterTable();
}
window.updateFilters = updateFilters;

function populateFilterDropdowns() {
    const container = document.getElementById('ownerFilterItemsContainer');
    if (!container) return;
    const ownersSet = new Set();
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        const owner = row.cells[13]?.querySelector('input')?.value?.trim();
        if (owner) ownersSet.add(owner);
    });

    const ownersList = Array.from(ownersSet).sort();
    if (ownersList.length === 0) return;

    if (!isOwnerFilterInitialized) {
        activeOwnerFilters = [...ownersList];
        isOwnerFilterInitialized = true;
    }

    totalOwnerOptionsCount = ownersList.length;
    container.innerHTML = '';
    ownersList.forEach(owner => {
        const label = document.createElement('label');
        label.className = 'multi-select-item';
        const cb = document.createElement('input'); 
        cb.type = 'checkbox'; 
        cb.value = owner; 
        if (activeOwnerFilters.includes(owner)) cb.checked = true;
        cb.addEventListener('change', updateFilters);
        const custom = document.createElement('span'); 
        custom.className = 'custom-cb'; 
        custom.innerHTML = '<i class="fas fa-check"></i>';
        label.append(cb, custom, document.createTextNode(' ' + owner));
        container.appendChild(label);
    });

    const ownerDot = document.getElementById('ownerFilterDot');
    if (ownerDot) {
        ownerDot.style.display = (activeOwnerFilters.length < totalOwnerOptionsCount) ? 'inline-block' : 'none';
    }
}
window.populateFilterDropdowns = populateFilterDropdowns;

async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    if (action === 'تغيير المستخدم' || action === 'تغيير المالك') {
        const selectedChecks = Array.from(document.querySelectorAll('.select-check:checked')).filter(cb => isRowVisible(cb.closest('tr')));
        if (selectedChecks.length === 0) {
            Swal.fire({ icon: 'warning', text: 'يرجى تحديد صف واحد على الأقل من الصفوف الظاهرة', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6' });
            return;
        }
        const { value: newOwner } = await Swal.fire({
            title: 'تغيير المستخدم',
            input: 'text',
            inputLabel: `أدخل اسم المستخدم الجديد لعدد ${selectedChecks.length} صفوف ظاهرة:`,
            showCancelButton: true,
            confirmButtonText: 'حفظ التغيير',
            cancelButtonText: 'إلغاء',
            confirmButtonColor: '#3b82f6'
        });
        if (newOwner && newOwner.trim()) {
            selectedChecks.forEach(cb => {
                const row = cb.closest('tr');
                if (row) {
                    const comp = row.cells[1]?.querySelector('input')?.value || '';
                    const ownerInp = row.cells[13]?.querySelector('input');
                    const oldOwner = ownerInp ? ownerInp.value : '';
                    if (ownerInp) {
                        ownerInp.value = newOwner.trim();
                        ownerInp.dataset.old = newOwner.trim();
                    }
                    addToActivityLog('المستخدم', oldOwner, newOwner.trim(), comp, newOwner.trim());
                    updateEditDateField(row);
                    debouncedSaveSingleRow(row.id);
                }
            });
            populateFilterDropdowns();
            Swal.fire({ icon: 'success', title: 'تم التحديث بنجاح', timer: 1500, showConfirmButton: false });
        }
        return;
    }
    if (action === 'استيراد' || action === 'استيراد من Excel') {
        const input = document.getElementById('importFileInput');
        if (input) { input.value=''; input.click(); }
        return;
    }
    if (action === 'تصدير' || action === 'تصدير إلى Excel') { exportOpportunitiesToExcel(); return; }
    if (action === 'طباعة') { printOpportunities(); return; }
    if (action.includes('حذف')) {
        const selected = Array.from(document.querySelectorAll('.select-check:checked')).filter(cb => isRowVisible(cb.closest('tr')));
        if (selected.length === 0) {
            Swal.fire({icon: 'info', text: 'يرجى تحديد صف واحد على الأقل من الصفوف الظاهرة للحذف', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'});
            return;
        }
        const result = await Swal.fire({
            title: 'تأكيد الحذف؟', text: `سيتم حذف ${selected.length} فرصة محددة من الظاهرين نهائياً!`,
            icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#94a3b8',
            confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء'
        });
        if (result.isConfirmed) {
            Swal.fire({title: 'جاري الحذف...', allowOutsideClick: false, didOpen: () => Swal.showLoading()});
            let count = 0;
            const batch = db ? writeBatch(db) : null;

            for (let chk of selected) {
                const row = chk.closest('tr');
                if (row) {
                    const fid = row.dataset.firestoreId || row.id;
                    if (batch) {
                        batch.delete(doc(db, "opportunities", fid));
                    }
                    try {
                        let raw = localStorage.getItem(OPP_LOCAL_KEY);
                        if (raw) {
                            let localCache = JSON.parse(raw);
                            delete localCache[row.id];
                            delete localCache[fid];
                            localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
                        }
                    } catch(e){}
                    const sub = document.getElementById('sub-' + row.id);
                    if (sub) sub.remove();
                    row.remove();
                    count++;
                }
            }

            if (batch) {
                try { await batch.commit(); } catch(e) { console.warn(e); }
            }

            reorderRows();
            updateStats();
            updateMasterCheckboxState();
            populateFilterDropdowns();
            Swal.fire({icon: 'success', title: `تم حذف ${count} فرصة`, showConfirmButton: false, timer: 1500});
        }
    }
}
window.handleBulkAction = handleBulkAction;

function exportOpportunitiesToExcel() {
    let rowsToExport = [];
    const selectedChecks = Array.from(document.querySelectorAll('.select-check:checked')).filter(cb => isRowVisible(cb.closest('tr')));
    if (selectedChecks.length > 0) rowsToExport = selectedChecks.map(chk => chk.closest('tr')).filter(r => r && r.id);
    else rowsToExport = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(isRowVisible);

    if (rowsToExport.length === 0) {
        Swal.fire({icon: 'info', text: 'لا توجد بيانات ظاهرة للتصدير', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'});
        return;
    }
    const exportData = rowsToExport.map(row => {
        const getVal = (cellIdx) => row.cells[cellIdx]?.querySelector('input, select')?.value || '';
        const getNote = () => {
            try {
                const preview = row.cells[10]?.querySelector('.notes-preview');
                const jsonStr = preview?.dataset.fullNotes || '[]';
                const arr = JSON.parse(jsonStr);
                return arr.map(n => `${n.date} ${n.time} - ${n.text}`).join(' | ');
            } catch(e) { return row.cells[10]?.querySelector('.notes-preview')?.innerText || ''; }
        };
        return {
            'الشركة': getVal(1), 'العنوان': getVal(2), 'المسؤول': getVal(3),
            'رقم التواصل': getVal(4), 'الإيميل': getVal(5), 'السجل التجاري': getVal(6),
            'تاريخ الفرصة': row.querySelector('.opp-date-val')?.value || '',
            'الخدمة': getVal(8), 'القيمة': getVal(9), 'الملاحظات': getNote(),
            'الحالة': getVal(11), 'التاريخ المتوقع': row.querySelector('.exp-date-input')?.value || '', 'المالك': getVal(13)
        };
    });
    try {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "الفرص البيعية");
        ws['!cols'] = [{wch:20},{wch:15},{wch:15},{wch:15},{wch:20},{wch:15},{wch:12},{wch:20},{wch:12},{wch:30},{wch:12},{wch:15},{wch:15}];
        const fileName = `الفرص_البيعية_${getTodayFormatted()}.xlsx`;
        XLSX.writeFile(wb, fileName);
        Swal.fire({icon: 'success', title: `تم تصدير ${exportData.length} فرصة ظاهرة`, showConfirmButton: false, timer: 1500});
    } catch (err) {
        console.error('خطأ التصدير', err);
        Swal.fire({icon: 'error', title: 'خطأ في التصدير', text: err.message});
    }
}
window.exportOpportunitiesToExcel = exportOpportunitiesToExcel;

function printOpportunities() {
    const selectedChecks = Array.from(document.querySelectorAll('.select-check:checked')).filter(cb => isRowVisible(cb.closest('tr')));
    let rowsToPrint;
    if (selectedChecks.length > 0) rowsToPrint = selectedChecks.map(chk => chk.closest('tr')).filter(r => r && r.id);
    else rowsToPrint = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(isRowVisible);

    if (rowsToPrint.length === 0) { Swal.fire({icon: 'info', text: 'لا توجد بيانات ظاهرة للطباعة'}); return; }

    const rowsHtml = rowsToPrint.map(row => {
        const getVal = (idx) => row.cells[idx]?.querySelector('input, select')?.value || '';
        const getNote = () => {
            try {
                const preview = row.cells[10]?.querySelector('.notes-preview');
                const jsonStr = preview?.dataset.fullNotes || '[]';
                const arr = JSON.parse(jsonStr);
                return arr.map(n => `${n.date} ${n.time} - ${n.text}`).join(' | ');
            } catch(e) { return row.cells[10]?.querySelector('.notes-preview')?.innerText || ''; }
        };
        return `<tr>
            <td>${escapeHTML(getVal(1))}</td><td>${escapeHTML(getVal(2))}</td><td>${escapeHTML(getVal(3))}</td>
            <td>${escapeHTML(getVal(4))}</td><td>${escapeHTML(getVal(5))}</td><td>${escapeHTML(getVal(6))}</td>
            <td>${escapeHTML(row.querySelector('.opp-date-val')?.value || '')}</td><td>${escapeHTML(getVal(8))}</td>
            <td>${escapeHTML(getVal(9))}</td><td>${escapeHTML(getNote())}</td><td>${escapeHTML(getVal(11))}</td>
            <td>${escapeHTML(row.querySelector('.exp-date-input')?.value || '')}</td><td>${escapeHTML(getVal(13))}</td>
        </tr>`;
    }).join('');

    const win = window.open('', '_blank');
    if (!win) { Swal.fire({icon:'error', text:'المتصفح منع فتح نافذة الطباعة'}); return; }
    win.document.write(`
        <html dir="rtl"><head><meta charset="UTF-8"><title>طباعة الفرص</title>
        <style>body{font-family:Cairo, sans-serif; font-size:11px;} table{width:100%; border-collapse:collapse;} th, td{border:1px solid #ccc; padding:6px; text-align:right;} th{background:#f1f5f9; font-weight:800; height:40px;}</style></head><body>
        <h3 style="text-align:center">الفرص البيعية - ${new Date().toLocaleDateString('ar-EG')}</h3>
        <table><thead><tr><th>الشركة</th><th>العنوان</th><th>المسؤول</th><th>رقم التواصل</th><th>الإيميل</th><th>السجل</th><th>تاريخ الفرصة</th><th>الخدمة</th><th>القيمة</th><th>الملاحظات</th><th>الحالة</th><th>التاريخ المتوقع</th><th>المالك</th></tr></thead><tbody>${rowsHtml}</tbody></table>
        <script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
}
window.printOpportunities = printOpportunities;

function debouncedFilterTable() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => filterTable(), 250);
}
window.debouncedFilterTable = debouncedFilterTable;

function filterTable() {
    const searchInput = document.getElementById('searchInput');
    const term = (searchInput?.value || '').toLowerCase().trim();

    const statusCbs = document.querySelectorAll('#statusFilterMenu input[type="checkbox"]');
    totalStatusOptionsCount = statusCbs.length || 3;

    const ownerCbs = document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]');
    totalOwnerOptionsCount = ownerCbs.length;

    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        const subRow = document.getElementById('sub-' + row.id);
        let showBySearch = true;
        let showByStatus = true;
        let showByOwner = true;

        if (term) {
            const text = row.innerText.toLowerCase();
            const notes = row.cells[10]?.querySelector('.notes-preview')?.dataset.fullNotes?.toLowerCase() || '';
            showBySearch = text.includes(term) || notes.includes(term);
        }

        if (totalStatusOptionsCount > 0) {
            if (activeStatusFilters.length === 0) {
                showByStatus = false;
            } else if (activeStatusFilters.length < totalStatusOptionsCount) {
                const status = row.cells[11]?.querySelector('select')?.value || '';
                showByStatus = activeStatusFilters.includes(status);
            } else {
                showByStatus = true;
            }
        }

        if (totalOwnerOptionsCount > 0) {
            if (activeOwnerFilters.length === 0) {
                showByOwner = false;
            } else if (activeOwnerFilters.length < totalOwnerOptionsCount) {
                const owner = row.cells[13]?.querySelector('input')?.value?.trim() || '';
                showByOwner = activeOwnerFilters.includes(owner);
            } else {
                showByOwner = true;
            }
        }

        const shouldShow = showBySearch && showByStatus && showByOwner;
        row.style.display = shouldShow ? '' : 'none';
        if (subRow && !shouldShow) subRow.style.display = 'none';

        if (!shouldShow) {
            const chk = row.querySelector('.select-check');
            if (chk) chk.checked = false;
        }
    });

    reorderRows();
    updateStats();
    updateMasterCheckboxState();
}
window.filterTable = filterTable;

function reorderRows() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    tbody.querySelectorAll('.month-separator').forEach(el => el.remove());
    const rows = Array.from(tbody.querySelectorAll('.main-row')).filter(r => r.style.display !== 'none');
    
    const arabicMonths = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const today = new Date();
    const todayMonthKey = `${today.getFullYear()}-${today.getMonth()}`;

    const monthMap = {};
    const rowsWithoutDate = [];

    rows.forEach(row => {
        const expDate = row.querySelector('.exp-date-input')?.value || '';
        const parsed = parseDateLocal(expDate);
        if (parsed) {
            const monthKey = `${parsed.getFullYear()}-${parsed.getMonth()}`;
            if (!monthMap[monthKey]) monthMap[monthKey] = [];
            monthMap[monthKey].push(row);
        } else {
            rowsWithoutDate.push(row);
        }
    });

    if (rowsWithoutDate.length > 0) {
        rowsWithoutDate.sort((a, b) => {
            const edA = a.querySelector('.edit-date-val')?.value || '';
            const edB = b.querySelector('.edit-date-val')?.value || '';
            if (edA && edB && edA !== edB) return edB.localeCompare(edA);
            return (b.id || '').localeCompare(a.id || '');
        });

        const sep = document.createElement('tr');
        sep.className = 'month-separator sep-no-date';
        sep.id = 'noDateSeparator';
        sep.dataset.monthKey = 'no-date';
        sep.innerHTML = `<td colspan="14"><div class="sep-text"><i class="fas fa-calendar-plus" style="margin-left:6px; color:#d97706;"></i> فرص جديدة / بدون تاريخ متوقع <span class="sep-no-date-badge">${rowsWithoutDate.length}</span></div></td>`;
        tbody.appendChild(sep);

        rowsWithoutDate.forEach(row => {
            tbody.appendChild(row);
            const sub = document.getElementById('sub-' + row.id);
            if (sub) tbody.appendChild(sub);
        });
    }

    if (!monthMap[todayMonthKey]) monthMap[todayMonthKey] = [];

    const sortedMonthKeys = Object.keys(monthMap).sort((a, b) => {
        const [ya,ma] = a.split('-').map(Number);
        const [yb,mb] = b.split('-').map(Number);
        if (ya !== yb) return yb - ya;
        return mb - ma;
    });

    sortedMonthKeys.forEach(monthKey => {
        monthMap[monthKey].sort((a, b) => {
            const da = a.querySelector('.exp-date-input')?.value || '';
            const db = b.querySelector('.exp-date-input')?.value || '';
            return db.localeCompare(da);
        });
    });

    sortedMonthKeys.forEach(monthKey => {
        const [y, m] = monthKey.split('-').map(Number);
        const monthLabel = `${arabicMonths[m]} ${y}`;
        const isCurrentMonth = (monthKey === todayMonthKey);

        const sep = document.createElement('tr');
        sep.className = 'month-separator' + (isCurrentMonth ? ' current-month-separator' : '');
        sep.dataset.monthKey = monthKey;
        if (isCurrentMonth) sep.id = 'currentMonthSeparator';
        sep.innerHTML = `<td colspan="14"><div class="sep-text ${isCurrentMonth ? 'sep-current-month' : ''}">${monthLabel}</div></td>`;
        tbody.appendChild(sep);

        monthMap[monthKey].forEach(row => {
            tbody.appendChild(row);
            const sub = document.getElementById('sub-' + row.id);
            if (sub) tbody.appendChild(sub);
        });
    });

    if (!initialScrollDone) {
        scrollToCurrentMonthSeparator();
    }
}

function scrollToCurrentMonthSeparator(force = false) {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('highlight') && !force) return false;

    const wrapper = document.querySelector('.table-wrapper');
    if (!wrapper) return false;

    let targetSep = document.getElementById('currentMonthSeparator') || 
                    document.querySelector('.sep-current-month')?.closest('tr');
    if (!targetSep) {
        targetSep = document.querySelector('.month-separator:not(.sep-no-date)');
    }

    if (targetSep) {
        const thead = document.querySelector('#mainTable thead');
        const headerHeight = (thead && thead.offsetHeight) ? thead.offsetHeight : 38;
        const offset = Math.max(0, Math.round(targetSep.offsetTop - headerHeight));

        wrapper.style.scrollBehavior = 'auto';
        wrapper.scrollTop = offset;

        initialScrollDone = true;
        return true;
    }
    return false;
}
window.scrollToCurrentMonthSeparator = scrollToCurrentMonthSeparator;

function triggerAutoScrollToCurrentMonth() {
    if (initialScrollDone) return;
    scrollToCurrentMonthSeparator();
}
window.triggerAutoScrollToCurrentMonth = triggerAutoScrollToCurrentMonth;

function insertNewRow() {
    const newId = generateRowId();
    const today = getTodayFormatted();
    const newOpp = {
        id: newId,
        comp: '',
        address: '',
        mgr: '',
        mob: '',
        email: '',
        record: '',
        oppDate: today,
        curServ: '',
        oppValue: 0,
        notes: '[]',
        status: '',
        expDate: '',
        editDate: new Date().toISOString(),
        owner: '',
        products: []
    };

    renderRow(newOpp, true);

    try {
        let raw = localStorage.getItem(OPP_LOCAL_KEY);
        let cache = raw ? JSON.parse(raw) : {};
        if (Array.isArray(cache)) {
            const arr = cache;
            cache = {};
            arr.forEach(it => { cache[it.id] = it; });
        }
        cache[newId] = newOpp;
        localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(cache));
    } catch(e) {
        console.warn("Error caching new opportunity locally:", e);
    }

    debouncedSaveSingleRow(newId);
    populateFilterDropdowns();
    filterTable();

    const wrapper = document.querySelector('.table-wrapper');
    if (wrapper) {
        wrapper.scrollTo({ top: 0, behavior: 'smooth' });
        wrapper.scrollTop = 0;
    }

    const rowEl = document.getElementById(sanitizeId(newId));
    if (rowEl) {
        rowEl.style.transition = 'background-color 0.5s ease';
        rowEl.style.backgroundColor = 'rgba(217, 119, 6, 0.15)';
        setTimeout(() => { rowEl.style.backgroundColor = ''; }, 1800);
        const compInp = rowEl.querySelector('.col-company input');
        if (compInp) compInp.focus();
    }
}
window.insertNewRow = insertNewRow;

function updateStats() {
    const allRows = Array.from(document.querySelectorAll('#tableBody .main-row'));
    const visibleRows = allRows.filter(r => r.style.display !== 'none');
    const total = visibleRows.length;
    const todayStr = getTodayFormatted();
    const thisMonth = todayStr.substring(0,7);
    let monthCount = 0, todayCount = 0;
    let totalValue = 0, monthValue = 0;

    visibleRows.forEach(row => {
        const expDate = row.querySelector('.exp-date-input')?.value || '';
        const status = row.cells[11]?.querySelector('select')?.value || '';
        const val = parseFloat(row.cells[9]?.querySelector('input')?.value) || 0;
        
        totalValue += val;
        
        if (status === 'مهتم') {
            if (expDate && expDate.startsWith(thisMonth)) { 
                monthCount++; 
                monthValue += val; 
            }
            if (expDate === todayStr) {
                todayCount++;
            }
        }
    });

    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('stat-total', total);
    setText('stat-month', monthCount);
    setText('stat-today', todayCount);
    setText('stat-value-total', totalValue.toLocaleString());
    setText('stat-value-month', monthValue.toLocaleString());
}
window.updateStats = updateStats;

function toggleSubTable(rowId) {
    const sub = document.getElementById('sub-' + rowId);
    if (!sub) return;
    const isOpen = sub.style.display === 'table-row';
    sub.style.display = isOpen ? 'none' : 'table-row';
    const main = document.getElementById(rowId);
    const arrow = main?.querySelector('.toggle-arrow');
    const icon = main?.querySelector('.toggle-arrow i');
    if (icon) icon.className = isOpen ? 'fas fa-caret-left' : 'fas fa-caret-down';
    if (arrow) arrow.classList.toggle('arrow-open', !isOpen);
}
window.toggleSubTable = toggleSubTable;

function applyStatusColor(selectEl) {
    if (!selectEl) return;
    const row = selectEl.closest('tr');
    if (!row) return;
    row.classList.remove('closed-row','row-shrink','status-interested','status-won','status-lost');
    selectEl.classList.remove('status-won-cell', 'status-lost-cell');
    const val = selectEl.value;
    if (val === 'رابح') {
        row.classList.add('closed-row','row-shrink','status-won');
        selectEl.classList.add('status-won-cell');
    } else if (val === 'فقدان') {
        row.classList.add('closed-row','row-shrink','status-lost');
        selectEl.classList.add('status-lost-cell');
    } else if (val === 'مهتم') {
        row.classList.add('status-interested');
    }
}
window.applyStatusColor = applyStatusColor;

function handleStatusChange(selectEl, rowId) {
    const oldVal = selectEl.dataset.old || '';
    const newVal = selectEl.value;
    const row = document.getElementById(rowId);
    const company = row?.cells[1]?.querySelector('input')?.value || '';
    const owner = row?.cells[13]?.querySelector('input')?.value || '';
    applyStatusColor(selectEl);
    addToActivityLog('الحالة', oldVal, newVal, company, owner);
    selectEl.dataset.old = newVal;
    updateEditDateField(row);
    debouncedSaveSingleRow(rowId);
    filterTable();
}
window.handleStatusChange = handleStatusChange;

function updateEditDateField(row) {
    if (!row) return;
    const today = getTodayFormatted();
    const editValInput = row.querySelector('.edit-date-val');
    if (editValInput) editValInput.value = today;
    const subRow = document.getElementById('sub-' + row.id);
    if (subRow) {
        const container = subRow.querySelector('.edit-date-container-sub');
        if (container) container.innerHTML = parseEditDateHTML(today);
    }
}
window.updateEditDateField = updateEditDateField;

function parseEditDateHTML(dateStr) {
    if (!dateStr) return '<span style="color:#94a3b8">-</span>';
    let display = formatDateToDisplay(dateStr.split(' ')[0]);
    return `<div style="text-align:center; line-height:1.6;">
        <div style="font-weight:800; color:#1e293b; font-size:11px;">${escapeHTML(display)}</div>
        <div style="font-size:9px; color:#64748b;">${escapeHTML(getTimeFormatted())}</div>
    </div>`;
}
window.parseEditDateHTML = parseEditDateHTML;

function getLastNoteOnlyFromJSON(jsonStr) {
    try {
        const arr = JSON.parse(jsonStr || '[]');
        if (!arr.length) return '';
        const last = arr[arr.length - 1];
        return last.text ? (last.text.length > 35 ? last.text.substring(0,35)+'...' : last.text) : '';
    } catch(e) { return ''; }
}
window.getLastNoteOnlyFromJSON = getLastNoteOnlyFromJSON;

function toggleLogExpansion() {
    const section = document.getElementById('activityLogSection');
    const btn = document.getElementById('toggleExpandBtn');
    if (!section) return;
    section.classList.toggle('expanded');
    const icon = btn?.querySelector('i');
    if (icon) icon.className = section.classList.contains('expanded') ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
}
window.toggleLogExpansion = toggleLogExpansion;

function parseOppNoteDateTime(dateStr, timeStr) {
    if (!dateStr) return new Date(NaN);
    let cleanedDate = String(dateStr).replace(/\//g, '-');
    let parts = cleanedDate.split('-');
    let year, month, day;
    if (parts.length === 3) {
        if (parts[0].length === 4) { year = parseInt(parts[0], 10); month = parseInt(parts[1], 10) - 1; day = parseInt(parts[2], 10); } 
        else { day = parseInt(parts[2], 10); month = parseInt(parts[1], 10) - 1; year = parseInt(parts[0], 10); }
    } else { return new Date(dateStr); }
    let hours = 0, minutes = 0;
    if (timeStr && timeStr.includes(':')) { let tParts = timeStr.split(':'); hours = parseInt(tParts[0], 10) || 0; minutes = parseInt(tParts[1], 10) || 0; }
    return new Date(year, month, day, hours, minutes);
}

function openNote(previewEl) {
    currentNotePreviewEl = previewEl;
    const jsonStr = previewEl.dataset.fullNotes || '[]';
    let notes = [];
    try { notes = JSON.parse(jsonStr); } catch(e){}
    const historyLog = document.getElementById('historyLog');
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    if (historyLog) {
        if (!notes.length) {
            historyLog.innerHTML = '<div style="color:#64748b; text-align:center; font-size:11px; padding:20px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
        } else {
            historyLog.innerHTML = notes.map((msg, index) => {
                let msgDateObj = parseOppNoteDateTime(msg.date, msg.time);
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
                </div>
                `;
            }).join('');
        }
    }
    const modal = document.getElementById('noteModal');
    if (modal) {
        modal.classList.add('active');
        modal.style.display = 'flex';
        if (historyLog) historyLog.scrollTop = historyLog.scrollHeight;
    }
    const area = document.getElementById('modalTextArea');
    if (area) { area.value = ''; area.focus(); }
}
window.openNote = openNote;

function closeNote() {
    const modal = document.getElementById('noteModal');
    if (modal) {
        modal.classList.remove('active');
        modal.style.display = 'none';
    }
    currentNotePreviewEl = null;
}
window.closeNote = closeNote;

function saveNote() {
    const area = document.getElementById('modalTextArea');
    const text = (area?.value || '').trim();
    if (!text) { closeNote(); return; }
    if (!currentNotePreviewEl) return;
    const jsonStr = currentNotePreviewEl.dataset.fullNotes || '[]';
    let notes = [];
    try { notes = JSON.parse(jsonStr); } catch(e){}
    const ownerInput = currentNotePreviewEl.closest('tr')?.cells[13]?.querySelector('input');
    const user = (ownerInput?.value?.trim() && ownerInput.value.trim() !== 'المستخدم') ? ownerInput.value.trim() : 'أحمد';
    const d = new Date();
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yyyy = d.getFullYear();
    notes.push({ text, date: `${dd}-${mm}-${yyyy}`, time: getTimeFormatted(), user, timestamp: Date.now() });
    const updatedJson = JSON.stringify(notes);
    currentNotePreviewEl.dataset.fullNotes = updatedJson;
    currentNotePreviewEl.textContent = text;
    const row = currentNotePreviewEl.closest('tr');
    if (row) {
        const comp = row.cells[1]?.querySelector('input')?.value || '';
        addToActivityLog('الملاحظات', '', text, comp, user);
        updateEditDateField(row);
        saveRowLocally(row.id);
        saveSingleRow(row.id);
    }
    closeNote();
    if (area) area.value = '';
}
window.saveNote = saveNote;

async function deleteNote(index) {
    if (!currentNotePreviewEl) return;
    const result = await Swal.fire({
        title: 'تأكيد الحذف؟',
        text: 'هل أنت متأكد من حذف هذه الملاحظة؟',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#94a3b8',
        confirmButtonText: 'نعم، احذف',
        cancelButtonText: 'إلغاء'
    });
    if (!result.isConfirmed) return;

    const jsonStr = currentNotePreviewEl.dataset.fullNotes || '[]';
    let notes = [];
    try { notes = JSON.parse(jsonStr); } catch(e){}
    const removedNote = notes[index]?.text || '';
    notes.splice(index, 1);
    const updatedJson = JSON.stringify(notes);
    currentNotePreviewEl.dataset.fullNotes = updatedJson;
    const lastText = getLastNoteOnlyFromJSON(updatedJson);
    if (lastText) currentNotePreviewEl.textContent = lastText;
    else currentNotePreviewEl.innerHTML = '<span style="color:#94a3b8">بدون ملاحظات</span>';
    const row = currentNotePreviewEl.closest('tr');
    openNote(currentNotePreviewEl);
    if (row) {
        const comp = row.cells[1]?.querySelector('input')?.value || '';
        const owner = row.cells[13]?.querySelector('input')?.value || 'المستخدم';
        addToActivityLog('الملاحظات', removedNote || 'ملاحظة', '', comp, owner);
        updateEditDateField(row);
        saveRowLocally(row.id);
        saveSingleRow(row.id);
    }
}
window.deleteNote = deleteNote;

function openCustomDatePicker(event, displayInput, rowId) {
    if (event) event.stopPropagation();
    currentCalendarTarget = displayInput;
    currentCalendarRowId = rowId;
    const hiddenInput = displayInput.parentElement?.querySelector('.exp-date-input');
    const currentVal = hiddenInput?.value || '';
    const parsed = parseDateLocal(currentVal);
    calendarCurrentDate = parsed || new Date();
    renderCalendar();
    const overlay = document.getElementById('calendarOverlay');
    if (overlay) overlay.classList.add('active');
}
window.openCustomDatePicker = openCustomDatePicker;

function closeCalendar() {
    const overlay = document.getElementById('calendarOverlay');
    if (overlay) overlay.classList.remove('active');
    currentCalendarTarget = null;
    currentCalendarRowId = null;
}
window.closeCalendar = closeCalendar;

function renderCalendar() {
    const monthDisplay = document.getElementById('calMonthDisplay');
    const yearDisplay = document.getElementById('calYearDisplay');
    const daysGrid = document.getElementById('calDaysGrid');
    if (!monthDisplay || !yearDisplay || !daysGrid) return;
    const year = calendarCurrentDate.getFullYear();
    const month = calendarCurrentDate.getMonth();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    monthDisplay.textContent = monthNames[month];
    yearDisplay.textContent = year;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const today = new Date();
    const hiddenVal = currentCalendarTarget?.parentElement?.querySelector('.exp-date-input')?.value || '';
    let html = '';
    for (let i=0;i<firstDay;i++) html += '<span class="empty-day"></span>';
    for (let d=1; d<=daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isToday = today.getDate()===d && today.getMonth()===month && today.getFullYear()===year;
        const isSelected = hiddenVal === dateStr;
        const dayOfWeek = new Date(year, month, d).getDay();
        const isWeekend = dayOfWeek===5 || dayOfWeek===6;
        html += `<span class="day-number ${isToday?'today-day':''} ${isSelected?'selected-day':''} ${isWeekend?'weekend-number':''}" data-date="${dateStr}">${d}</span>`;
    }
    daysGrid.innerHTML = html;
    daysGrid.querySelectorAll('.day-number').forEach(el=>{
        el.addEventListener('click', ()=> selectCalendarDay(el.dataset.date));
    });
}

function selectCalendarDay(dateStr) {
    if (currentCalendarTarget) {
        const hidden = currentCalendarTarget.parentElement?.querySelector('.exp-date-input');
        const row = document.getElementById(currentCalendarRowId);
        const oldVal = hidden?.value || '';
        if (hidden) hidden.value = dateStr;
        currentCalendarTarget.value = formatDateToDisplay(dateStr);
        if (row) {
            if (hidden) hidden.dataset.old = dateStr;
            updateEditDateField(row);
            debouncedSaveSingleRow(currentCalendarRowId);
            reorderRows();
            populateFilterDropdowns();
            updateStats();
        }
    }
    closeCalendar();
}
window.selectCalendarDay = selectCalendarDay;

function handleImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type:'array'});
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(sheet);
            if (!json.length) { Swal.fire({icon:'info', text:'الملف فارغ'}); return; }
            Swal.fire({title:`جاري استيراد ${json.length} صف...`, allowOutsideClick:false, didOpen:()=>Swal.showLoading()});
            
            let count=0;
            const BATCH_SIZE = 400;
            let batch = db ? writeBatch(db) : null;
            let batchCounter = 0;

            for (const row of json) {
                const id = generateRowId();
                const mapped = {
                    comp: row['الشركة'] || row['Company'] || '',
                    address: row['العنوان'] || row['Address'] || '',
                    mgr: row['المسؤول'] || row['Manager'] || '',
                    mob: row['رقم التواصل'] || row['Mobile'] || '',
                    email: row['الإيميل'] || row['Email'] || '',
                    record: row['السجل التجاري'] || row['السجل الرئيسي'] || row['السجل'] || '',
                    oppDate: row['تاريخ الفرصة'] || getTodayFormatted(),
                    curServ: row['الخدمة'] || '',
                    oppValue: row['القيمة'] || '',
                    notes: '[]',
                    status: row['الحالة'] || 'مهتم',
                    expDate: row['التاريخ المتوقع'] || '',
                    editDate: getTodayFormatted(),
                    owner: row['المالك'] || row['المستخدم'] || row['Owner'] || '',
                    products: []
                };

                if (batch) {
                    batch.set(doc(db, "opportunities", id), mapped, { merge: true });
                    batchCounter++;
                    if (batchCounter % BATCH_SIZE === 0) {
                        await batch.commit();
                        batch = writeBatch(db);
                    }
                }

                renderRow({ id, ...mapped }, true);
                saveRowLocally(id);
                count++;
            }

            if (batch && batchCounter % BATCH_SIZE !== 0) {
                await batch.commit();
            }

            populateFilterDropdowns();
            filterTable();
            Swal.fire({icon:'success', title:`تم استيراد ${count} فرصة`, showConfirmButton:false, timer:1500});
        } catch(err) {
            console.error(err);
            Swal.fire({icon:'error', title:'خطأ في الاستيراد', text:err.message});
        }
    };
    reader.readAsArrayBuffer(file);
}

function initServiceHoverTooltip() {
    let tooltip = document.getElementById('oppServiceTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'oppServiceTooltip';
        tooltip.className = 'opp-service-popover';
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
        const input = cell.querySelector('input');
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
            }
        });

        table.addEventListener('mouseout', (e) => {
            const related = e.relatedTarget;
            if (activeCell && (!related || !activeCell.contains(related))) {
                hideTooltip();
            }
        });

        table.addEventListener('input', (e) => {
            if (e.target && e.target.closest('.col-service, td.col-service') && activeCell) {
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

window.initServiceHoverTooltip = initServiceHoverTooltip;

document.addEventListener('DOMContentLoaded', () => {
    const statusCbs = document.querySelectorAll('#statusFilterMenu input[type="checkbox"]');
    if (statusCbs.length > 0) {
        statusCbs.forEach(cb => cb.checked = true);
        activeStatusFilters = Array.from(statusCbs).map(cb => cb.value);
        totalStatusOptionsCount = statusCbs.length;
    }

    listenToOpportunities();
    loadLogsData();
    
    const importInput = document.getElementById('importFileInput');
    if (importInput) {
        importInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleImportFile(file);
            e.target.value='';
        });
    }
    
    document.getElementById('prevMonthBtn')?.addEventListener('click', (e)=>{ e.stopPropagation(); calendarCurrentDate.setMonth(calendarCurrentDate.getMonth()-1); renderCalendar(); });
    document.getElementById('nextMonthBtn')?.addEventListener('click', (e)=>{ e.stopPropagation(); calendarCurrentDate.setMonth(calendarCurrentDate.getMonth()+1); renderCalendar(); });
    document.getElementById('prevYearBtn')?.addEventListener('click', (e)=>{ e.stopPropagation(); calendarCurrentDate.setFullYear(calendarCurrentDate.getFullYear()-1); renderCalendar(); });
    document.getElementById('nextYearBtn')?.addEventListener('click', (e)=>{ e.stopPropagation(); calendarCurrentDate.setFullYear(calendarCurrentDate.getFullYear()+1); renderCalendar(); });
    document.getElementById('calCancelBtn')?.addEventListener('click', closeCalendar);
    document.getElementById('calClearBtn')?.addEventListener('click', ()=>{
        if (currentCalendarTarget) {
            const hidden = currentCalendarTarget.parentElement?.querySelector('.exp-date-input');
            if (hidden) hidden.value = '';
            currentCalendarTarget.value = '';
            if (currentCalendarRowId) {
                const row = document.getElementById(currentCalendarRowId);
                if (row) { 
                    updateEditDateField(row); 
                    debouncedSaveSingleRow(currentCalendarRowId);
                    reorderRows();
                    populateFilterDropdowns();
                    updateStats();
                }
            }
        }
        closeCalendar();
    });
    document.getElementById('calNextBtn')?.addEventListener('click', ()=>{ closeCalendar(); });
    document.getElementById('calendarOverlay')?.addEventListener('click', (e)=>{ if (e.target.id === 'calendarOverlay') closeCalendar(); });

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
    localStorage.setItem('asgate_opps_stats_hidden', isHidden ? 'true' : 'false');
}

function initStatsVisibility() {
    const isHidden = localStorage.getItem('asgate_opps_stats_hidden') === 'true';
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

    const tableWrapperEl = document.querySelector('.table-wrapper');
    if (tableWrapperEl) {
        const markManualScroll = () => { userHasManuallyScrolled = true; };
        tableWrapperEl.addEventListener('wheel', markManualScroll, { passive: true });
        tableWrapperEl.addEventListener('touchmove', markManualScroll, { passive: true });
        tableWrapperEl.addEventListener('mousedown', (e) => {
            if (e.offsetX > tableWrapperEl.clientWidth || e.offsetX < 0) markManualScroll();
        });
    }

    initStatsVisibility();
    scrollToCurrentMonthSeparator();
    initServiceHoverTooltip();

    const urlParams = new URLSearchParams(window.location.search);
    const highlightId = urlParams.get('highlight');
    if (highlightId) {
        setTimeout(() => {
            if (typeof window.triggerElementHighlight === 'function') {
                window.triggerElementHighlight(highlightId);
            }
        }, 350);
    }
});

document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => m.classList.remove('show'));
});
