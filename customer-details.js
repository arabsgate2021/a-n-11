// ==========================================
// customer-details.js - تفاصيل العميل وتتبع الأنشطة برقم السجل التجاري
// ==========================================
import Swal from 'sweetalert2';
window.Swal = Swal;
import { db, doc, getDoc, updateDoc, setDoc } from './firebase-config.js';
import { generateSalesOrderId, isCustomerMatchedByCr, checkCustomerCrDuplicate, normalizeCr, createActivityLogEntry } from './src/crm_logic.js';

let currentCustomer = null;
let customerCode = null;
const CUSTOMER_DETAIL_LOCAL_KEY = 'asgate_customer_detail_local_v1';
const VISITS_LOCAL_KEY = 'asgate_visits_local_cache_v1';

async function recordCustomerActivity(fieldName, oldVal, newVal, companyName, ownerName) {
    const logEntry = createActivityLogEntry({
        page: 'customers',
        fieldName,
        oldVal,
        newVal,
        identifierValue: companyName,
        user: ownerName
    });
    if (!logEntry) return;
    try {
        let logs = JSON.parse(localStorage.getItem('crm_activity_logs') || '[]');
        logs.unshift(logEntry);
        logs = logs.slice(0, 100);
        localStorage.setItem('crm_activity_logs', JSON.stringify(logs));
        if (db) {
            await setDoc(doc(db, "customers_activity_logs", logEntry.timestamp.toString()), logEntry);
        }
    } catch(e) {}
}

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
window.escapeHTML = escapeHTML;

function formatDateDisplay(dateString) {
    if (!dateString) return '-';
    let cleanDate = String(dateString).trim();
    if (cleanDate.includes('/')) {
        cleanDate = cleanDate.replace(/\//g, '-');
    }
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) { 
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
    }
    return cleanDate;
}

function saveCustomerLocally() {
    if (!customerCode || !currentCustomer) return;
    try {
        const nowIso = new Date().toISOString();
        currentCustomer.lastActivityDate = nowIso;
        currentCustomer.updatedAt = nowIso;
        if (currentCustomer.status === 'غير نشط' && currentCustomer.autoDeactivated) {
            currentCustomer.status = 'نشط';
            delete currentCustomer.autoDeactivated;
        }

        let cache = JSON.parse(localStorage.getItem(CUSTOMER_DETAIL_LOCAL_KEY) || '{}');
        cache[customerCode] = currentCustomer;
        localStorage.setItem(CUSTOMER_DETAIL_LOCAL_KEY, JSON.stringify(cache));

        let mainCusts = JSON.parse(localStorage.getItem('crm_customers') || '[]');
        const idx = mainCusts.findIndex(c => c.code === customerCode);
        if (idx > -1) {
            mainCusts[idx] = { ...mainCusts[idx], ...currentCustomer };
            localStorage.setItem('crm_customers', JSON.stringify(mainCusts));
            localStorage.setItem('asgate_customers_cache_v1', JSON.stringify(mainCusts));
        }
    } catch (e) {
        console.error("خطأ في الحفظ المحلي لتفاصيل العميل:", e);
    }
}

async function initPage() {
    const urlParams = new URLSearchParams(window.location.search);
    customerCode = urlParams.get('code') || localStorage.getItem('last_customer_code');
    
    // إذا لم يحدد الكود، نأخذ أول عميل موجود في الكاش تلقائياً
    if (!customerCode) {
        try {
            const allCusts = JSON.parse(localStorage.getItem('crm_customers') || '[]');
            if (allCusts.length > 0) {
                customerCode = allCusts[0].code;
            }
        } catch(e){}
    }

    if (!customerCode) {
        customerCode = "CUST-00001";
    }

    try {
        localStorage.setItem('last_customer_code', customerCode);
    } catch(e){}

    // 1. الاسترجاع الفوري من الذاكرة المحلية كبديل فوري (Zero latency)
    try {
        const cache = JSON.parse(localStorage.getItem(CUSTOMER_DETAIL_LOCAL_KEY) || '{}');
        if (cache[customerCode]) {
            currentCustomer = cache[customerCode];
            populateCustomerUI();
        } else {
            const allCusts = JSON.parse(localStorage.getItem('crm_customers') || '[]');
            const found = allCusts.find(c => c.code === customerCode);
            if (found) {
                currentCustomer = found;
                populateCustomerUI();
            }
        }
    } catch(e) {
        console.error("خطأ في قراءة الذاكرة المحلية:", e);
    }

    await loadCustomerData();
}

function populateCustomerUI() {
    if (!currentCustomer) return;
    
    if (!currentCustomer.managers || currentCustomer.managers.length === 0) {
        if (currentCustomer.mgr || currentCustomer.mob || currentCustomer.email) {
            const d = new Date();
            const fallbackDate = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
            
            currentCustomer.managers = [{
                id: Date.now(),
                name: currentCustomer.mgr || "",
                phone: currentCustomer.mob || "",
                altPhone: "",
                email: currentCustomer.email || "",
                jobTitle: "المسؤول الرئيسي",
                date: currentCustomer.creationDate || currentCustomer.date || fallbackDate,
                isPrimary: true
            }];
            saveToFirestore(); 
        } else {
            currentCustomer.managers = [];
        }
    }

    // ربط سجل الطلبات والزيارات والفرص من قواعد البيانات العامة تلقائياً بناءً على رقم السجل بدقة
    try {
        const allSales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        const custSales = allSales.filter(s => isCustomerMatchedByCr(currentCustomer, s));
        if (custSales.length > 0) {
            currentCustomer.orders = custSales.map(s => ({
                id: '#' + s.id,
                title: s.type || 'طلب مبيعات',
                date: s.date || '-',
                amount: (s.completedSum ? s.completedSum.toLocaleString() : '0') + ' ر.س',
                status: s.status || 'جديد'
            }));
            currentCustomer.sales = custSales.map(s => ({
                invId: 'INV-' + s.id,
                date: s.date || '-',
                total: (s.completedSum ? s.completedSum.toLocaleString() : '0') + ' ر.س',
                status: s.status || 'معتمد'
            }));
        }
    } catch(e){}

    try {
        const rawVisits = localStorage.getItem(VISITS_LOCAL_KEY);
        if (rawVisits) {
            const parsed = JSON.parse(rawVisits);
            const allVisits = Array.isArray(parsed) ? parsed : Object.values(parsed);
            const custVisits = allVisits.filter(v => isCustomerMatchedByCr(currentCustomer, v));
            if (custVisits.length > 0) {
                currentCustomer.visits = custVisits.map(v => ({
                    date: v.visitDate || '-',
                    visitor: v.owner || 'المستخدم',
                    purpose: v.curServ || 'زيارة ميدانية',
                    result: v.status || 'مكتملة'
                }));
            }
        }
    } catch(e){}

    try {
        const rawOpps = localStorage.getItem('asgate_opportunities_local_cache_v1');
        if (rawOpps) {
            const parsed = JSON.parse(rawOpps);
            const allOpps = Array.isArray(parsed) ? parsed : Object.values(parsed);
            const custOpps = allOpps.filter(o => isCustomerMatchedByCr(currentCustomer, o));
            if (custOpps.length > 0) {
                currentCustomer.opportunities = custOpps.map(o => ({
                    title: o.curServ || 'فرصة بيعية',
                    value: (Number(o.oppValue) || 0).toLocaleString() + ' ر.س',
                    stage: o.status || 'مهتم',
                    probability: o.status === 'رابح' ? '100%' : (o.status === 'فقدان' ? '0%' : '60%')
                }));
            }
        }
    } catch(e){}

    currentCustomer.orders = currentCustomer.orders || [];
    currentCustomer.visits = currentCustomer.visits || [];
    currentCustomer.opportunities = currentCustomer.opportunities || [];
    currentCustomer.sales = currentCustomer.sales || [];
    currentCustomer.attachments = currentCustomer.attachments || [];
    currentCustomer.primaryContact = currentCustomer.primaryContact || {};

    const cName = document.getElementById('c-name');
    if (cName) cName.textContent = currentCustomer.comp || currentCustomer.name || 'عميل غير مسمى';
    
    const cCode = document.getElementById('c-code');
    if (cCode) cCode.textContent = customerCode || currentCustomer.code || '-';

    const crEl = document.getElementById('c-cr');
    if (crEl) crEl.textContent = currentCustomer.cr || currentCustomer.cr1 || '-';
    
    const city = document.getElementById('c-city');
    if (city) city.textContent = currentCustomer.city || '-';
    
    const neighborhood = document.getElementById('c-neighborhood');
    if (neighborhood) neighborhood.textContent = currentCustomer.neighborhood || currentCustomer.address || '-';
    
    const classEl = document.getElementById('c-class');
    if (classEl) classEl.textContent = currentCustomer.classification || currentCustomer.source || '-';
    
    const statusEl = document.getElementById('c-status');
    if (statusEl) statusEl.textContent = currentCustomer.status || 'نشط';
    
    const owner = document.getElementById('c-owner');
    if (owner) owner.textContent = currentCustomer.owner || '-';
    
    const source = document.getElementById('c-source');
    if (source) source.textContent = currentCustomer.source || currentCustomer.date || '-';

    renderManagersTable();
    
    // تنشيط أول تبويب
    const activeTab = document.querySelector('.tab-btn.active');
    const tabName = activeTab ? activeTab.id.replace('btn-', '') : 'orders';
    if (typeof window.switchTab === 'function') {
        window.switchTab(tabName);
    }
}

async function loadCustomerData() {
    if (!db) return;
    try {
        const docRef = doc(db, "customers", customerCode);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            currentCustomer = docSnap.data();
            currentCustomer.code = customerCode;
            saveCustomerLocally();
            populateCustomerUI();
        } else if (!currentCustomer) {
            const cName = document.getElementById('c-name');
            if (cName) cName.textContent = "لم يتم العثور على بيانات العميل";
        }
    } catch (error) {
        console.warn("إشعار جلب بيانات العميل سحابياً (العمل محلياً):", error);
    }
}

function renderManagersTable() {
    const tbody = document.getElementById('managerTableBody');
    if(!tbody) return;
    tbody.innerHTML = '';

    if (!currentCustomer.managers || currentCustomer.managers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:15px; color:#94a3b8;">لا يوجد مسؤولون مسجلون. اضغط إضافة مسؤول جديد</td></tr>`;
        return;
    }

    currentCustomer.managers.forEach((mgr, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="text-center">
                <input type="radio" name="primaryManager" ${mgr.isPrimary ? 'checked' : ''} onchange="window.setPrimaryManager(${index})">
            </td>
            <td><input type="text" value="${escapeHTML(mgr.name || '')}" onchange="window.updateManager(${index}, 'name', this.value)"></td>
            <td><input type="text" value="${escapeHTML(mgr.phone || '')}" onchange="window.updateManager(${index}, 'phone', this.value)"></td>
            <td><input type="text" value="${escapeHTML(mgr.altPhone || '')}" onchange="window.updateManager(${index}, 'altPhone', this.value)"></td>
            <td><input type="email" value="${escapeHTML(mgr.email || '')}" onchange="window.updateManager(${index}, 'email', this.value)"></td>
            <td><input type="text" value="${escapeHTML(mgr.jobTitle || '')}" onchange="window.updateManager(${index}, 'jobTitle', this.value)"></td>
            <td dir="ltr" style="text-align: center;"><strong>${formatDateDisplay(mgr.date)}</strong></td>
            <td class="text-center">
                <button class="btn-icon" onclick="window.deleteManagerRow(${index})" title="حذف"><i class="fas fa-trash-alt"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

window.setPrimaryManager = function(selectedIndex) {
    if (!currentCustomer || !currentCustomer.managers) return;
    const oldName = currentCustomer.mgr || '';
    const oldPhone = currentCustomer.mob || '';
    const oldEmail = currentCustomer.email || '';

    currentCustomer.managers.forEach((mgr, idx) => {
        mgr.isPrimary = (idx === selectedIndex);
    });
    
    const selectedMgr = currentCustomer.managers[selectedIndex];
    if(selectedMgr) {
        currentCustomer.primaryContact = { name: selectedMgr.name, phone: selectedMgr.phone, email: selectedMgr.email };
        currentCustomer.mgr = selectedMgr.name;
        currentCustomer.mob = selectedMgr.phone;
        currentCustomer.email = selectedMgr.email;

        const compName = currentCustomer.comp || currentCustomer.name || '';
        const ownerName = currentCustomer.owner || 'المستخدم';
        recordCustomerActivity('اسم المسؤول', oldName, selectedMgr.name || '', compName, ownerName);
        recordCustomerActivity('رقم التواصل', oldPhone, selectedMgr.phone || '', compName, ownerName);
        recordCustomerActivity('البريد الالكتروني', oldEmail, selectedMgr.email || '', compName, ownerName);
    }

    saveToFirestore();
};

window.addNewManagerRow = function() {
    if (!currentCustomer) return;
    const d = new Date();
    const todayStr = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    
    if (!currentCustomer.managers) currentCustomer.managers = [];
    const newMgr = {
        id: Date.now(), name: "", phone: "", altPhone: "", email: "", jobTitle: "", date: todayStr,
        isPrimary: currentCustomer.managers.length === 0
    };
    
    currentCustomer.managers.push(newMgr);
    if(newMgr.isPrimary) {
        window.setPrimaryManager(currentCustomer.managers.length - 1);
    } else {
        saveToFirestore();
    }
    
    renderManagersTable();
};

window.updateManager = function(index, field, value) {
    if(!currentCustomer || !currentCustomer.managers[index]) return;
    const oldVal = currentCustomer.managers[index][field] || '';
    currentCustomer.managers[index][field] = value;
    
    if (currentCustomer.managers[index].isPrimary && (field === 'name' || field === 'phone' || field === 'email')) {
        if (!currentCustomer.primaryContact) currentCustomer.primaryContact = {};
        currentCustomer.primaryContact[field] = value;
        
        const compName = currentCustomer.comp || currentCustomer.name || '';
        const ownerName = currentCustomer.owner || 'المستخدم';
        if (field === 'name') {
            currentCustomer.mgr = value;
            recordCustomerActivity('اسم المسؤول', oldVal, value, compName, ownerName);
        }
        if (field === 'phone') {
            currentCustomer.mob = value;
            recordCustomerActivity('رقم التواصل', oldVal, value, compName, ownerName);
        }
        if (field === 'email') {
            currentCustomer.email = value;
            recordCustomerActivity('البريد الالكتروني', oldVal, value, compName, ownerName);
        }
    }
    
    saveToFirestore();
};

window.deleteManagerRow = function(index) {
    if (!currentCustomer || !currentCustomer.managers) return;
    if (confirm("هل أنت متأكد من حذف هذا المسؤول؟")) {
        const isWasPrimary = currentCustomer.managers[index].isPrimary;
        currentCustomer.managers.splice(index, 1);
        
        if (isWasPrimary && currentCustomer.managers.length > 0) {
            currentCustomer.managers[0].isPrimary = true;
            window.setPrimaryManager(0);
        } else {
            if (currentCustomer.managers.length === 0) {
                currentCustomer.primaryContact = {};
                currentCustomer.mgr = "";
                currentCustomer.mob = "";
                currentCustomer.email = "";
            }
            saveToFirestore();
        }
        renderManagersTable();
    }
};

window.switchTab = function(tabName) {
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => btn.classList.remove('active'));

    const activeBtn = document.getElementById(`btn-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');

    const thead = document.getElementById('tableHeadRow');
    const tbody = document.getElementById('contentBody');
    const title = document.getElementById('tab-title');

    if(!tbody || !thead || !title || !currentCustomer) return;
    tbody.innerHTML = '';

    if (tabName === 'orders') {
        title.textContent = 'سجل أوامر المبيعات والطلبات';
        thead.innerHTML = `<th>رقم الطلب</th><th>تفاصيل الطلب</th><th>التاريخ</th><th>المبلغ الإجمالي</th><th>الحالة</th><th>إجراء</th>`;
        if (!currentCustomer.orders || currentCustomer.orders.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:15px; color:#94a3b8;">لا توجد طلبات مسجلة لهذا العميل بعد</td></tr>`;
        } else {
            currentCustomer.orders.forEach(item => {
                const orderIdNum = item.id.replace('#', '');
                tbody.innerHTML += `<tr>
                    <td><a href="order_details.html?id=${encodeURIComponent(orderIdNum)}" style="color:#2563eb; font-weight:700; text-decoration:none;">${escapeHTML(item.id)}</a></td>
                    <td>${escapeHTML(item.title)}</td>
                    <td dir="ltr" style="text-align: right;"><strong>${formatDateDisplay(item.date)}</strong></td>
                    <td style="font-weight:700; color:#16a34a;">${escapeHTML(item.amount)}</td>
                    <td><span class="status-badge active">${escapeHTML(item.status)}</span></td>
                    <td><a href="order_details.html?id=${encodeURIComponent(orderIdNum)}" class="btn btn-outline" style="padding:2px 8px; font-size:11px;">عرض الفاتورة</a></td>
                </tr>`;
            });
        }
    } else if (tabName === 'visits') {
        title.textContent = 'سجل الزيارات الميدانية';
        thead.innerHTML = `<th>تاريخ الزيارة</th><th>الزائر (الموظف)</th><th>الهدف من الزيارة</th><th>النتيجة / الملاحظات</th>`;
        if (!currentCustomer.visits || currentCustomer.visits.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:15px; color:#94a3b8;">لا توجد زيارات مسجلة لهذا العميل بعد</td></tr>`;
        } else {
            currentCustomer.visits.forEach(item => {
                tbody.innerHTML += `<tr><td dir="ltr" style="text-align: right;"><strong>${formatDateDisplay(item.date)}</strong></td><td>${escapeHTML(item.visitor)}</td><td>${escapeHTML(item.purpose)}</td><td>${escapeHTML(item.result)}</td></tr>`;
            });
        }
    } else if (tabName === 'opportunities') {
        title.textContent = 'الفرص البيعية المرتبطة';
        thead.innerHTML = `<th>اسم الفرصة</th><th>القيمة التقديرية</th><th>المرحلة</th><th>نسبة النجاح</th>`;
        if (!currentCustomer.opportunities || currentCustomer.opportunities.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:15px; color:#94a3b8;">لا توجد فرص بيعية مسجلة لهذا العميل بعد</td></tr>`;
        } else {
            currentCustomer.opportunities.forEach(item => {
                tbody.innerHTML += `<tr><td>${escapeHTML(item.title)}</td><td style="font-weight:700; color:#2563eb;">${escapeHTML(item.value)}</td><td>${escapeHTML(item.stage)}</td><td>${escapeHTML(item.probability)}</td></tr>`;
            });
        }
    } else if (tabName === 'sales') {
        title.textContent = 'سجل الفواتير والمبيعات';
        thead.innerHTML = `<th>رقم الفاتورة</th><th>التاريخ</th><th>الإجمالي</th><th>الحالة</th>`;
        if (!currentCustomer.sales || currentCustomer.sales.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:15px; color:#94a3b8;">لا توجد فواتير مسجلة لهذا العميل بعد</td></tr>`;
        } else {
            currentCustomer.sales.forEach(item => {
                tbody.innerHTML += `<tr><td><b>${escapeHTML(item.invId)}</b></td><td dir="ltr" style="text-align: right;"><strong>${formatDateDisplay(item.date)}</strong></td><td style="font-weight:700; color:#16a34a;">${escapeHTML(item.total)}</td><td>${escapeHTML(item.status)}</td></tr>`;
            });
        }
    } else if (tabName === 'attachments') {
        title.textContent = 'الملفات والمرفقات الرسمية';
        thead.innerHTML = `<th>اسم الملف</th><th>تاريخ الإضافة</th><th>الحجم</th><th>تحميل</th>`;
        if (!currentCustomer.attachments || currentCustomer.attachments.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:15px; color:#94a3b8;">لا توجد مرفقات مسجلة لهذا العميل بعد</td></tr>`;
        } else {
            currentCustomer.attachments.forEach(item => {
                tbody.innerHTML += `<tr><td>${escapeHTML(item.name)}</td><td dir="ltr" style="text-align: right;"><strong>${formatDateDisplay(item.date)}</strong></td><td>${escapeHTML(item.size)}</td><td><button class="btn btn-outline" style="padding: 2px 8px;"><i class="fas fa-download"></i></button></td></tr>`;
            });
        }
    }
};

window.createNewVisit = async function() {
    if (!currentCustomer) {
        alert('بيانات العميل غير محملة بعد');
        return;
    }

    const today = new Date();
    const dStr = String(today.getDate()).padStart(2, '0') + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + today.getFullYear();
    const tStr = String(today.getHours()).padStart(2, '0') + ":" + String(today.getMinutes()).padStart(2, '0');
    const visitId = 'visit_' + Date.now();

    const newVisitData = {
        id: visitId,
        createdAt: Date.now(),
        comp: currentCustomer.comp || currentCustomer.name || '',
        address: currentCustomer.neighborhood || currentCustomer.address || currentCustomer.city || '',
        mgr: currentCustomer.mgr || currentCustomer.primaryContact?.name || '',
        mob: currentCustomer.mob || currentCustomer.primaryContact?.phone || '',
        email: currentCustomer.email || currentCustomer.primaryContact?.email || '',
        record: currentCustomer.cr || currentCustomer.cr1 || '',
        visitDate: dStr,
        curServ: 'زيارة ميدانية',
        oppValue: '0',
        notes: '[]',
        status: 'زيارة',
        editDate: `${dStr} ${tStr}`,
        owner: currentCustomer.owner || 'المستخدم',
        products: []
    };

    try {
        let visitsCache = {};
        try {
            const raw = localStorage.getItem(VISITS_LOCAL_KEY);
            if (raw) visitsCache = JSON.parse(raw);
            if (Array.isArray(visitsCache)) {
                let obj = {};
                visitsCache.forEach(v => { obj[v.id] = v; });
                visitsCache = obj;
            }
        } catch(e){}
        visitsCache[visitId] = newVisitData;
        localStorage.setItem(VISITS_LOCAL_KEY, JSON.stringify(visitsCache));

        if (db) {
            await setDoc(doc(db, "visits", visitId), newVisitData);
        }

        if (!currentCustomer.visits) currentCustomer.visits = [];
        currentCustomer.visits.unshift({
            date: dStr,
            visitor: currentCustomer.owner || 'المستخدم',
            purpose: 'زيارة ميدانية جديدة',
            result: 'تم التجهيز والربط مع صفحة الزيارات'
        });

        await saveToFirestore();
        populateCustomerUI();

        if (typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'success',
                title: 'تم إنشاء الزيارة بنجاح',
                text: 'تمت إضافة الزيارة برقم السجل التجاري وربطها بسجل زيارات العميل',
                timer: 2000,
                showConfirmButton: false
            });
        } else {
            alert('تم إنشاء الزيارة بنجاح!');
        }

        if (typeof window.switchTab === 'function') {
            window.switchTab('visits');
        }

    } catch (error) {
        console.error("خطأ في إضافة الزيارة:", error);
        alert('حدث خطأ أثناء إضافة الزيارة الجديدة.');
    }
};

async function saveToFirestore() {
    saveCustomerLocally(); 
    if (db && customerCode) {
        try {
            await updateDoc(doc(db, "customers", customerCode), currentCustomer);
        } catch (error) {
            console.warn("إشعار حفظ تفاصيل العميل سحابياً:", error);
        }
    }
}

window.openEditModal = function() {
    if (!currentCustomer) return;
    
    document.getElementById('editCode').value = currentCustomer.code || customerCode || '';
    document.getElementById('editComp').value = currentCustomer.comp || currentCustomer.name || '';
    document.getElementById('editCity').value = currentCustomer.city || '';
    document.getElementById('editAddress').value = currentCustomer.neighborhood || currentCustomer.address || '';
    document.getElementById('editCr').value = currentCustomer.cr || currentCustomer.cr1 || '';
    document.getElementById('editOwner').value = currentCustomer.owner || '';
    document.getElementById('editSource').value = currentCustomer.source || currentCustomer.date || '';
    
    const classSelect = document.getElementById('editClass');
    if (classSelect) classSelect.value = currentCustomer.classification || 'صغير';
    
    const statusSelect = document.getElementById('editStatus');
    if (statusSelect) statusSelect.value = currentCustomer.status || 'نشط';

    document.getElementById('editCustomerModal').style.display = 'flex';
};

window.closeEditModal = function() {
    document.getElementById('editCustomerModal').style.display = 'none';
};

window.saveCustomerEdits = async function(event) {
    if (!currentCustomer || !customerCode) return;

    const newComp = document.getElementById('editComp').value.trim();
    if (newComp === '') {
        alert('اسم الشركة مطلوب');
        return;
    }

    const editCr = document.getElementById('editCr').value.trim();

    let allCusts = [];
    try {
        allCusts = JSON.parse(localStorage.getItem('crm_customers') || '[]');
    } catch(e){}

    const dupCheck = checkCustomerCrDuplicate({
        cr: editCr,
        existingCustomers: allCusts,
        currentCustomerCode: customerCode
    });

    if (dupCheck.isDuplicate) {
        if (typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'warning',
                title: 'العميل مسجل سابقا',
                text: dupCheck.message || 'العميل مسجل سابقا برقم السجل التجاري المدخل.',
                confirmButtonText: 'حسناً',
                confirmButtonColor: '#2563eb'
            });
        } else {
            alert(dupCheck.message || 'العميل مسجل سابقا');
        }
        return;
    }

    const oldComp = currentCustomer.comp || currentCustomer.name || '';
    const oldCity = currentCustomer.city || '';
    const oldCr = currentCustomer.cr || currentCustomer.cr1 || '';
    const oldClass = currentCustomer.classification || '';
    const oldStatus = currentCustomer.status || '';
    const oldOwner = currentCustomer.owner || '';

    const newCity = document.getElementById('editCity').value.trim();
    const newAddress = document.getElementById('editAddress').value.trim();
    const newClass = document.getElementById('editClass').value;
    const newStatus = document.getElementById('editStatus').value;
    const newOwner = document.getElementById('editOwner').value.trim();

    currentCustomer.comp = newComp;
    currentCustomer.name = newComp; 
    currentCustomer.city = newCity;
    currentCustomer.neighborhood = newAddress;
    currentCustomer.address = newAddress;
    currentCustomer.cr = editCr;
    currentCustomer.cr1 = editCr;
    delete currentCustomer.cr2;
    currentCustomer.classification = newClass;
    currentCustomer.status = newStatus;
    currentCustomer.owner = newOwner; 

    const activeUser = newOwner || oldOwner || 'المستخدم';
    recordCustomerActivity('اسم الشركة', oldComp, newComp, newComp, activeUser);
    recordCustomerActivity('المدينة', oldCity, newCity, newComp, activeUser);
    recordCustomerActivity('السجل التجاري', oldCr, editCr, newComp, activeUser);
    recordCustomerActivity('تصنيف العميل', oldClass, newClass, newComp, activeUser);
    recordCustomerActivity('حالة العميل', oldStatus, newStatus, newComp, activeUser);
    recordCustomerActivity('المستخدم', oldOwner, newOwner, newComp, activeUser);

    try {
        const btn = event.target;
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الحفظ...';
        btn.disabled = true;

        await saveToFirestore();
        populateCustomerUI();

        closeEditModal();
        btn.innerHTML = originalText;
        btn.disabled = false;
        
        if (typeof Swal !== 'undefined') {
            Swal.fire('نجاح', 'تم تحديث بيانات العميل بنجاح وتمت المزامنة!', 'success');
        } else {
            alert('تم تحديث البيانات بنجاح!');
        }

    } catch (error) {
        console.error("خطأ في تحديث البيانات:", error);
        alert('حدث خطأ أثناء حفظ التعديلات.');
        if (event.target) event.target.disabled = false;
    }
};

window.openNoteModal = function() { const m = document.getElementById('noteModal'); if(m) m.style.display = 'flex'; };
window.closeNoteModal = function() { const m = document.getElementById('noteModal'); if(m) m.style.display = 'none'; };

window.handleFileSelect = function(input) {
    const fileName = input.files[0] ? input.files[0].name : "لم يتم اختيار ملف";
    const el = document.getElementById('fileName');
    if(el) el.textContent = fileName;
};

window.saveActivity = function() {
    const noteEl = document.getElementById('activityNote');
    const note = noteEl ? noteEl.value : '';
    if (note.trim() === '') return alert('يرجى كتابة الملاحظة أولاً');
    
    const d = new Date();
    const dStr = String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear();
    if (!currentCustomer.notesHistory) currentCustomer.notesHistory = [];
    currentCustomer.notesHistory.push({
        user: currentCustomer.owner || 'المستخدم',
        date: dStr,
        time: String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0'),
        text: note.trim()
    });
    currentCustomer.notesText = note.trim();
    saveToFirestore();
    recordCustomerActivity(
        'الملاحظات',
        '',
        note.trim(),
        currentCustomer.comp || currentCustomer.name || customerCode || '',
        currentCustomer.owner || 'المستخدم'
    );

    if (typeof Swal !== 'undefined') {
        Swal.fire({ icon: 'success', title: 'تم حفظ النشاط والملاحظة بنجاح', timer: 1600, showConfirmButton: false });
    } else {
        alert('تم حفظ النشاط بنجاح');
    }
    if(noteEl) noteEl.value = '';
    window.closeNoteModal();
};

window.openNewSalesOrderModal = function() {
    if (!currentCustomer) {
        if (typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'warning', title: 'تنبيه', text: 'بيانات العميل جاري تحميلها، يرجى الانتظار...' });
        } else {
            alert('بيانات العميل جاري تحميلها، يرجى الانتظار...');
        }
        return;
    }

    const modal = document.getElementById('orderModal');
    if (!modal) return;

    const mComp = document.getElementById('mComp');
    const mCr = document.getElementById('mCr');
    const mType = document.getElementById('mType');

    const compName = currentCustomer.comp || currentCustomer.name || '';
    const crValue = currentCustomer.cr || currentCustomer.cr1 || '';

    if (mComp) mComp.value = compName;
    if (mCr) mCr.value = crValue;
    if (mType) {
        mType.value = '';
        setTimeout(() => mType.focus(), 80);
    }

    modal.style.display = 'flex';
};

window.closeOrderModal = function() {
    const modal = document.getElementById('orderModal');
    if (modal) modal.style.display = 'none';
};

window.submitNewSalesOrder = async function() {
    if (!currentCustomer) return;
    const mType = document.getElementById('mType');
    const type = mType ? mType.value.trim() : '';

    if (!type) {
        if (typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'warning', title: 'تنبيه', text: 'يرجى إدخال اسم أو تفاصيل الطلب', confirmButtonColor: '#2563eb' });
        } else {
            alert('يرجى إدخال اسم أو تفاصيل الطلب');
        }
        if (mType) mType.focus();
        return;
    }

    const comp = (document.getElementById('mComp')?.value || currentCustomer.comp || currentCustomer.name || '').trim();
    const cr = (document.getElementById('mCr')?.value || currentCustomer.cr || currentCustomer.cr1 || '').trim();

    let allSales = [];
    try {
        allSales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    } catch(e) {}

    const newId = generateSalesOrderId(allSales, new Date());

    const d = new Date();
    const dStr = String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear();

    const newOrder = {
        id: newId,
        type: type,
        date: dStr,
        comp: comp,
        cr: cr,
        status: 'جديد',
        note: '',
        lastModifiedDate: dStr,
        owner: currentCustomer.owner || 'المستخدم',
        completedSum: 0,
        pendingSum: 0
    };

    allSales.unshift(newOrder);
    localStorage.setItem('asgate_sales_db', JSON.stringify(allSales));

    try {
        let productsDb = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
        productsDb[newId] = [];
        localStorage.setItem('asgate_products_db', JSON.stringify(productsDb));
    } catch(e) {}

    if (db) {
        try {
            await setDoc(doc(db, "sales", newId), newOrder);
        } catch(err) {
            console.warn("إشعار حفظ سحابي للطلب:", err);
        }
    }

    // إضافة الطلب إلى قوائم العميل المعروضة
    if (!currentCustomer.orders) currentCustomer.orders = [];
    currentCustomer.orders.unshift({
        id: '#' + newId,
        title: type,
        date: dStr,
        amount: '0.00 ر.س',
        status: 'جديد'
    });

    if (!currentCustomer.sales) currentCustomer.sales = [];
    currentCustomer.sales.unshift({
        invId: 'INV-' + newId,
        date: dStr,
        total: '0.00 ر.س',
        status: 'معتمد'
    });

    // تحديث نشاط العميل وتاريخ التحديث ليتحول إلى الأخضر 00B050
    const nowIso = new Date().toISOString();
    currentCustomer.lastActivityDate = nowIso;
    currentCustomer.updatedAt = nowIso;
    if (currentCustomer.status === 'غير نشط' && currentCustomer.autoDeactivated) {
        currentCustomer.status = 'نشط';
        delete currentCustomer.autoDeactivated;
    }
    saveCustomerLocally();
    if (db) {
        try { await saveToFirestore(); } catch(e){}
    }

    window.closeOrderModal();

    // التبديل فوراً لتبويب سجل الطلبات لعرض الطلب المنشأ
    window.switchTab('orders');

    if (typeof Swal !== 'undefined') {
        Swal.fire({
            icon: 'success',
            title: 'تم إنشاء طلب المبيعات بنجاح',
            html: `
                <div style="font-family:'Cairo', sans-serif; font-size:13px; line-height:1.7;">
                    تم إنشاء الطلب <b>#${escapeHTML(newId)}</b> باسم: <b>${escapeHTML(type)}</b><br>
                    لحساب منشأة: <b>${escapeHTML(comp)}</b><br>
                    وتم ربطه برقم السجل التجاري (${escapeHTML(cr || '-')}) مباشرة.
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: '<i class="fas fa-file-invoice"></i> فتح تفاصيل الطلب',
            cancelButtonText: 'البقاء في ملف العميل',
            confirmButtonColor: '#2563eb',
            cancelButtonColor: '#64748b'
        }).then((result) => {
            if (result.isConfirmed) {
                localStorage.setItem('current_order_id', String(newId));
                window.location.href = `order_details.html?id=${encodeURIComponent(String(newId))}`;
            }
        });
    } else {
        alert(`تم إنشاء الطلب #${newId} بنجاح!`);
    }
};

function checkCustomerDetailsHighlight() {
    const urlParams = new URLSearchParams(window.location.search);
    const highlightId = urlParams.get('highlight');
    if (highlightId) {
        setTimeout(() => {
            const clientHeader = document.querySelector('.client-title-block');
            if (clientHeader) {
                clientHeader.scrollIntoView({ behavior: 'smooth', block: 'center' });
                clientHeader.classList.remove('highlight-pulse-card');
                void clientHeader.offsetWidth;
                clientHeader.classList.add('highlight-pulse-card');
                setTimeout(() => clientHeader.classList.remove('highlight-pulse-card'), 2800);
            }
        }, 600);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initPage();
    checkCustomerDetailsHighlight();
});
