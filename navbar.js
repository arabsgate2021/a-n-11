// ==========================================
// navbar.js - الشريط العلوي الموحد لنظام ASGate CRM
// يشمل:
// 1. نظام التنبيهات الفوري مع أيقونة الكرة الأرضية (🌐) وعلامة التنبيه الحمراء
// 2. البحث الشامل السريع عبر كافة أقسام النظام (العملاء، الزيارات، الفرص، المبيعات، التذكيرات)
// 3. دعم الوضع الليلي وتخزين الحالة محلياً
// 4. الانتقال التلقائي للفرصة، الزيارة، العميل، التذكير أو الطلب عند النقر
// ==========================================

import { calculateCrmNotifications } from './src/crm_logic.js';

let searchTimeout = null;
let isNavbarInitialized = false;
let currentNotificationFilter = 'all';
let currentNotificationsList = [];

const READ_NOTIFICATIONS_KEY = 'asgate_read_notifications_v1';

const navbarStyles = `
#navbarPlaceholder {
    height: 58px;
    min-height: 58px;
    max-height: 58px;
    flex-shrink: 0;
    flex-grow: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    display: block;
    overflow: visible;
    box-sizing: border-box;
}

.top-navbar[data-unified="true"] {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background-color: #ffffff;
    height: 58px;
    min-height: 58px;
    max-height: 58px;
    padding: 0 16px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
    position: sticky;
    top: 0;
    z-index: 99999;
    border-bottom: 1px solid #e2e8f0;
    width: 100%;
    box-sizing: border-box;
    margin: 0;
    font-family: 'Cairo', sans-serif;
    line-height: 1;
    gap: 12px;
    direction: rtl;
}

.top-navbar * {
    box-sizing: border-box;
    font-family: 'Cairo', sans-serif;
}

.top-navbar .nav-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 800;
    font-size: 14.5px;
    color: #0f172a;
    white-space: nowrap;
    flex-shrink: 0;
    line-height: 1;
    text-decoration: none;
}

.top-navbar .nav-links {
    display: flex;
    align-items: center;
    gap: 3px;
    margin: 0;
    padding: 0;
    list-style: none;
    height: 100%;
    flex-shrink: 0;
}

.top-navbar .nav-links a {
    text-decoration: none;
    color: #334155;
    font-weight: 700;
    font-size: 12px;
    padding: 0 10px;
    height: 32px;
    min-height: 32px;
    max-height: 32px;
    border-radius: 6px;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    line-height: 1;
    white-space: nowrap;
}

.top-navbar .nav-links a:hover {
    background-color: #f1f5f9;
    color: #2563eb;
}

.top-navbar .nav-links a.active {
    background-color: #2563eb !important;
    color: #ffffff !important;
    font-weight: 800;
    box-shadow: 0 2px 4px rgba(37, 99, 235, 0.25);
}

/* حاوية الإشعارات والكرة الأرضية */
.nav-notifications-container {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
}

.nav-globe-btn {
    position: relative;
    background: transparent;
    border: 1px solid #e2e8f0;
    color: #1e293b;
    width: 36px;
    height: 36px;
    min-width: 36px;
    min-height: 36px;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: all 0.2s ease;
}

.nav-globe-btn:hover, .nav-globe-btn.active {
    background-color: #eff6ff;
    border-color: #2563eb;
    color: #2563eb;
    transform: translateY(-1px);
}

.notification-badge {
    position: absolute;
    top: -5px;
    left: -5px;
    background: #ef4444;
    color: #ffffff;
    font-size: 10px;
    font-weight: 900;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    box-shadow: 0 2px 6px rgba(239, 68, 68, 0.45);
    border: 2px solid #ffffff;
    animation: pulseGlobeBadge 2s infinite;
}

@keyframes pulseGlobeBadge {
    0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
    70% { transform: scale(1.08); box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
    100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
}

/* القائمة المنسدلة للإشعارات */
.notifications-dropdown {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    right: auto;
    width: 380px;
    max-width: min(380px, calc(100vw - 20px));
    box-sizing: border-box;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    box-shadow: 0 15px 35px -5px rgba(15, 23, 42, 0.18), 0 5px 15px rgba(0, 0, 0, 0.06);
    display: none;
    flex-direction: column;
    z-index: 10000;
    text-align: right;
    direction: rtl;
    overflow: hidden;
    animation: fadeInDropdown 0.2s ease-out;
}

/* وميض أصفر مرة واحدة (يضيء ويطفئ مرة واحدة) */
@keyframes highlightSingleYellowPulse {
    0% {
        background-color: transparent;
        box-shadow: none;
    }
    35% {
        background-color: #FEF08A;
        box-shadow: 0 0 24px rgba(234, 179, 8, 0.9), inset 0 0 14px rgba(234, 179, 8, 0.35);
    }
    70% {
        background-color: #FEF08A;
        box-shadow: 0 0 12px rgba(234, 179, 8, 0.4);
    }
    100% {
        background-color: transparent;
        box-shadow: none;
    }
}

@keyframes highlightSingleYellowPulseChild {
    0% {
        background-color: transparent;
        color: inherit;
    }
    35% {
        background-color: #FEF08A;
        color: #713f12;
    }
    70% {
        background-color: #FEF08A;
        color: #713f12;
    }
    100% {
        background-color: transparent;
        color: inherit;
    }
}

.highlight-pulse-row,
.highlight-pulse-card {
    animation: highlightSingleYellowPulse 1.1s cubic-bezier(0.4, 0, 0.2, 1) 1 forwards !important;
    position: relative !important;
    z-index: 100 !important;
}

.highlight-pulse-row td,
.highlight-pulse-row input,
.highlight-pulse-row select,
.highlight-pulse-row textarea,
.highlight-pulse-row .excel-input,
.highlight-pulse-row span,
.highlight-pulse-card,
.highlight-pulse-card * {
    animation: highlightSingleYellowPulseChild 1.1s cubic-bezier(0.4, 0, 0.2, 1) 1 forwards !important;
}

@keyframes highlightSingleYellowPulseDark {
    0% {
        background-color: transparent;
        box-shadow: none;
    }
    35% {
        background-color: rgba(234, 179, 8, 0.45);
        box-shadow: 0 0 24px rgba(250, 204, 21, 0.9);
    }
    70% {
        background-color: rgba(234, 179, 8, 0.3);
        box-shadow: 0 0 12px rgba(250, 204, 21, 0.4);
    }
    100% {
        background-color: transparent;
        box-shadow: none;
    }
}

@keyframes highlightSingleYellowPulseDarkChild {
    0% {
        background-color: transparent;
    }
    35% {
        background-color: rgba(234, 179, 8, 0.45);
        color: #fef08a;
    }
    70% {
        background-color: rgba(234, 179, 8, 0.3);
    }
    100% {
        background-color: transparent;
    }
}

body.dark-mode .highlight-pulse-row,
body.dark-mode .highlight-pulse-card {
    animation: highlightSingleYellowPulseDark 1.1s cubic-bezier(0.4, 0, 0.2, 1) 1 forwards !important;
    position: relative !important;
    z-index: 100 !important;
}

body.dark-mode .highlight-pulse-row td,
body.dark-mode .highlight-pulse-row input,
body.dark-mode .highlight-pulse-row select,
body.dark-mode .highlight-pulse-row textarea,
body.dark-mode .highlight-pulse-row .excel-input,
body.dark-mode .highlight-pulse-row span,
body.dark-mode .highlight-pulse-card,
body.dark-mode .highlight-pulse-card * {
    animation: highlightSingleYellowPulseDarkChild 1.1s cubic-bezier(0.4, 0, 0.2, 1) 1 forwards !important;
}

@keyframes fadeInDropdown {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
}

.notifications-dropdown.show {
    display: flex !important;
}

.notifications-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: #f8fafc;
    border-bottom: 1px solid #e2e8f0;
}

.notifications-header-title {
    font-size: 13px;
    font-weight: 800;
    color: #0f172a;
    display: flex;
    align-items: center;
    gap: 7px;
}

.notifications-header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
}

.btn-mark-all-read {
    background: transparent;
    border: none;
    color: #2563eb;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: background-color 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.btn-mark-all-read:hover {
    background: #eff6ff;
}

.notifications-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
    background: #ffffff;
    border-bottom: 1px solid #f1f5f9;
    overflow-x: auto;
    white-space: nowrap;
}

.notif-tab {
    padding: 4px 9px;
    border-radius: 20px;
    border: 1px solid #e2e8f0;
    background: #ffffff;
    color: #64748b;
    font-size: 10.5px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s ease;
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.notif-tab:hover {
    border-color: #cbd5e1;
    color: #1e293b;
    background: #f8fafc;
}

.notif-tab.active {
    background: #2563eb;
    color: #ffffff;
    border-color: #2563eb;
}

.notifications-list {
    max-height: 380px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
}

.notification-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid #f1f5f9;
    text-decoration: none;
    color: inherit;
    cursor: pointer;
    transition: background-color 0.15s ease;
    position: relative;
}

.notification-item:hover {
    background-color: #f8fafc;
}

.notification-item.unread {
    background-color: rgba(239, 246, 255, 0.6);
}

.notification-item.unread:hover {
    background-color: #eff6ff;
}

.notification-icon-wrap {
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 2px;
}

.icon-wrap-opportunity { background: #fef3c7; color: #d97706; }
.icon-wrap-customer { background: #fee2e2; color: #dc2626; }
.icon-wrap-visit { background: #dcfce7; color: #16a34a; }
.icon-wrap-reminder { background: #e0e7ff; color: #4338ca; }
.icon-wrap-sale { background: #f3e8ff; color: #7e22ce; }

.notification-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.notif-top-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
}

.notif-title {
    font-size: 12px;
    font-weight: 800;
    color: #0f172a;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.notif-badge-pill {
    font-size: 9.5px;
    font-weight: 800;
    padding: 2px 6px;
    border-radius: 10px;
    white-space: nowrap;
    flex-shrink: 0;
}

.badge-warning { background: #fef3c7; color: #b45309; }
.badge-danger { background: #fee2e2; color: #b91c1c; }
.badge-success { background: #dcfce7; color: #15803d; }
.badge-primary { background: #dbeafe; color: #1d4ed8; }
.badge-info { background: #f3e8ff; color: #6b21a8; }

.notif-message {
    font-size: 11px;
    font-weight: 600;
    color: #475569;
    line-height: 1.4;
    word-break: break-word;
}

.notif-footer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 2px;
    font-size: 10px;
    color: #94a3b8;
    font-weight: 600;
}

.notif-action-text {
    color: #2563eb;
    font-weight: 800;
    display: inline-flex;
    align-items: center;
    gap: 3px;
}

.unread-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #2563eb;
    position: absolute;
    top: 14px;
    left: 12px;
}

.notifications-empty {
    padding: 30px 20px;
    text-align: center;
    color: #64748b;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 700;
}

.notifications-empty i {
    font-size: 32px;
    color: #cbd5e1;
}

/* حاوية البحث */
.top-navbar .nav-search-container { 
    position: relative; 
    width: 240px; 
    max-width: 280px;
    height: 36px;
    flex-shrink: 1;
    display: flex;
    align-items: center;
}
.top-navbar .nav-search-input-wrapper { 
    position: relative; 
    display: flex; 
    align-items: center;
    width: 100%;
    height: 100%;
}
.top-navbar .nav-search-input-wrapper i.search-icon { 
    position: absolute; 
    right: 12px; 
    color: #94a3b8; 
    font-size: 13px;
    line-height: 1;
    pointer-events: none;
}
.top-navbar #globalSearchInput {
    width: 100%;
    padding: 0 34px 0 12px;
    border-radius: 8px;
    border: 1px solid #cbd5e1;
    background-color: #f8fafc;
    color: #1e293b;
    font-family: 'Cairo', sans-serif;
    font-size: 11.5px;
    outline: none;
    height: 36px;
    min-height: 36px;
    max-height: 36px;
    line-height: 36px;
    box-sizing: border-box;
    transition: all 0.2s ease;
}
.top-navbar #globalSearchInput:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
    background-color: #ffffff;
}
.top-navbar .search-results-dropdown {
    position: absolute; 
    top: calc(100% + 8px); 
    right: 0; 
    left: 0;
    background: #ffffff; 
    border: 1px solid #e2e8f0; 
    border-radius: 10px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.15); 
    max-height: 380px; 
    overflow-y: auto;
    display: none; 
    z-index: 1050; 
    text-align: right;
}
.top-navbar .search-results-dropdown.show { display: block; }
.top-navbar .search-result-item {
    display: flex; 
    flex-direction: column; 
    gap: 4px; 
    padding: 10px 14px;
    border-bottom: 1px solid #f1f5f9; 
    text-decoration: none; 
    color: #1e293b;
    transition: background-color 0.15s ease;
}
.top-navbar .search-result-item:hover { background-color: #f8fafc; }
.top-navbar .result-header { display: flex; justify-content: space-between; align-items: center; }
.top-navbar .result-title { font-weight: 700; font-size: 12px; color: #1e293b; }
.top-navbar .result-badge { font-size: 9.5px; padding: 2px 7px; border-radius: 12px; font-weight: 700; }
.badge-customers { background: #e0f2fe; color: #0284c7; }
.badge-visits { background: #dcfce7; color: #16a34a; }
.badge-opportunities { background: #fef3c7; color: #d97706; }
.badge-sales { background: #f3e8ff; color: #7e22ce; }
.badge-reminders { background: #fee2e2; color: #dc2626; }
.top-navbar .result-details { font-size: 10.5px; color: #64748b; }
.top-navbar .search-no-results { padding: 16px; text-align: center; color: #64748b; font-size: 11.5px; }
.top-navbar .nav-actions { display: flex; align-items: center; gap: 8px; height: 100%; flex-shrink: 0; }
.top-navbar .nav-btn {
    background: transparent; 
    border: 1px solid #e2e8f0; 
    color: #475569;
    width: 36px; 
    height: 36px; 
    min-width: 36px; 
    min-height: 36px;
    max-width: 36px; 
    max-height: 36px;
    border-radius: 8px;
    cursor: pointer; 
    display: flex; 
    align-items: center;
    justify-content: center; 
    font-size: 14px;
    line-height: 1;
    padding: 0;
    transition: all 0.2s ease;
}
.top-navbar .nav-btn:hover { background-color: #f1f5f9; color: #2563eb; border-color: #cbd5e1; }

/* الوضع الليلي */
body.dark-mode .top-navbar[data-unified="true"] { background-color: #1e293b; border-bottom-color: #334155; }
body.dark-mode .top-navbar .nav-brand { color: #f8fafc; }
body.dark-mode .top-navbar .nav-links a { color: #cbd5e1; }
body.dark-mode .top-navbar .nav-links a:hover { background-color: #334155; color: #60a5fa; }
body.dark-mode .top-navbar .nav-links a.active { background-color: #2563eb !important; color: #ffffff !important; }
body.dark-mode .top-navbar #globalSearchInput { background-color: #0f172a; border-color: #334155; color: #f8fafc; }
body.dark-mode .top-navbar .search-results-dropdown { background-color: #1e293b; border-color: #334155; }
body.dark-mode .top-navbar .search-result-item { border-bottom-color: #334155; color: #f8fafc; }
body.dark-mode .top-navbar .search-result-item:hover { background-color: #334155; }
body.dark-mode .top-navbar .result-title { color: #f8fafc; }
body.dark-mode .top-navbar .result-details { color: #94a3b8; }
body.dark-mode .top-navbar .nav-btn { border-color: #334155; color: #cbd5e1; }
body.dark-mode .top-navbar .nav-btn:hover { background-color: #334155; color: #60a5fa; }

body.dark-mode .nav-globe-btn { border-color: #334155; color: #cbd5e1; }
body.dark-mode .nav-globe-btn:hover, body.dark-mode .nav-globe-btn.active { background-color: #0f172a; color: #60a5fa; border-color: #3b82f6; }
body.dark-mode .notifications-dropdown { background-color: #1e293b; border-color: #334155; color: #f8fafc; }
body.dark-mode .notifications-header { background-color: #0f172a; border-bottom-color: #334155; }
body.dark-mode .notifications-header-title { color: #f8fafc; }
body.dark-mode .notifications-tabs { background-color: #1e293b; border-bottom-color: #334155; }
body.dark-mode .notif-tab { background-color: #0f172a; border-color: #334155; color: #94a3b8; }
body.dark-mode .notif-tab:hover { background-color: #334155; color: #f8fafc; }
body.dark-mode .notif-tab.active { background-color: #2563eb; color: #ffffff; border-color: #2563eb; }
body.dark-mode .notification-item { border-bottom-color: #334155; }
body.dark-mode .notification-item:hover { background-color: #0f172a; }
body.dark-mode .notification-item.unread { background-color: rgba(30, 58, 138, 0.25); }
body.dark-mode .notification-item.unread:hover { background-color: rgba(30, 58, 138, 0.4); }
body.dark-mode .notif-title { color: #f8fafc; }
body.dark-mode .notif-message { color: #cbd5e1; }
body.dark-mode .notifications-empty { color: #94a3b8; }
body.dark-mode .notifications-empty i { color: #475569; }
body.dark-mode .notification-badge { border-color: #1e293b; }
`;

function injectNavbarStyles() {
    if (document.getElementById('unified-navbar-styles')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'unified-navbar-styles';
    styleEl.textContent = navbarStyles;
    document.head.insertBefore(styleEl, document.head.firstChild);
}

function injectNavbarHTML() {
    const placeholder = document.getElementById('navbarPlaceholder');
    if (!placeholder) return;
    if (placeholder.querySelector('.top-navbar')) return;

    placeholder.innerHTML = `
    <nav class="top-navbar" data-unified="true">
        <div style="display:flex; align-items:center; gap:16px; height:100%;">
            <a href="index.html" class="nav-brand">
                <i class="fas fa-layer-group" style="color:#2563eb;"></i> ASGate CRM
            </a>
            <ul class="nav-links">
                <li><a href="index.html" id="nav-index"><i class="fas fa-home"></i> الرئيسية</a></li>
                <li><a href="visits.html" id="nav-visits"><i class="fas fa-map-marker-alt"></i> الزيارات</a></li>
                <li><a href="opportunities.html" id="nav-opportunities"><i class="fas fa-lightbulb"></i> الفرص البيعية</a></li>
                <li><a href="customers.html" id="nav-customers"><i class="fas fa-users"></i> العملاء</a></li>
                <li><a href="sales.html" id="nav-sales"><i class="fas fa-shopping-cart"></i> المبيعات</a></li>
                <li><a href="reminders.html" id="nav-reminders"><i class="fas fa-bell"></i> التذكيرات</a></li>
            </ul>
        </div>
        
        <div style="display:flex; align-items:center; gap:8px; height:100%;">
            <!-- أيقونة الكرة الأرضية للتنبيهات الفورية (على يمين مربع البحث) -->
            <div class="nav-notifications-container">
                <button type="button" class="nav-globe-btn" id="globeNotificationBtn" aria-label="الإشعارات والتنبيهات الفورية" title="التنبيهات الفورية والمتابعات">
                    <i class="fas fa-globe"></i>
                    <span class="notification-badge" id="notificationBadge" style="display:none;">0</span>
                </button>
                <div id="notificationsDropdown" class="notifications-dropdown">
                    <div class="notifications-header">
                        <div class="notifications-header-title">
                            <i class="fas fa-globe" style="color:#2563eb;"></i>
                            <span>التنبيهات والمتابعات</span>
                            <span id="notifCountTotalBadge" style="background:#e0f2fe; color:#0369a1; font-size:10px; font-weight:800; padding:1px 6px; border-radius:10px;">0</span>
                        </div>
                        <div class="notifications-header-actions">
                            <button type="button" class="btn-mark-all-read" id="markAllReadBtn" title="تحديد جميع التنبيهات كمقروءة">
                                <i class="fas fa-check-double"></i> قراءة الكل
                            </button>
                        </div>
                    </div>
                    
                    <div class="notifications-tabs">
                        <button type="button" class="notif-tab active" data-filter="all">الكل</button>
                        <button type="button" class="notif-tab" data-filter="today"><i class="far fa-calendar-check"></i> اليوم <span id="tabCountToday" style="opacity:0.8;"></span></button>
                        <button type="button" class="notif-tab" data-filter="unread"><i class="far fa-envelope"></i> غير مقروء <span id="tabCountUnread" style="opacity:0.8;"></span></button>
                        <button type="button" class="notif-tab" data-filter="opportunity"><i class="fas fa-lightbulb"></i> الفرص</button>
                        <button type="button" class="notif-tab" data-filter="customer"><i class="fas fa-users"></i> العملاء</button>
                        <button type="button" class="notif-tab" data-filter="visit"><i class="fas fa-map-marker-alt"></i> الزيارات</button>
                        <button type="button" class="notif-tab" data-filter="sale"><i class="fas fa-shopping-cart"></i> المبيعات</button>
                        <button type="button" class="notif-tab" data-filter="reminder"><i class="fas fa-bell"></i> التذكيرات</button>
                    </div>

                    <div class="notifications-list" id="notificationsList">
                        <!-- العناصر المولدة ديناميكياً -->
                    </div>
                </div>
            </div>

            <!-- مربع البحث الشامل -->
            <div class="nav-search-container">
                <div class="nav-search-input-wrapper">
                    <i class="fas fa-search search-icon"></i>
                    <input type="text" id="globalSearchInput" placeholder="بحث شامل في النظام...">
                </div>
                <div id="searchResults" class="search-results-dropdown"></div>
            </div>
            
            <div class="nav-actions">
                <button class="nav-btn" id="darkModeToggle" title="تبديل الوضع الليلي"><i class="fas fa-moon"></i></button>
            </div>
        </div>
    </nav>
    `;
}

function getCleanPageKey(urlStr) {
    if (!urlStr) return '';
    let clean = String(urlStr).split('?')[0].split('#')[0].toLowerCase();
    clean = clean.split('/').pop().trim();
    clean = clean.replace(/^(\.|\/)+/, '');
    if (clean === '' || clean === 'index' || clean === 'index.html') return 'index';
    return clean.replace(/\.html$/, '');
}

function highlightActiveLink() {
    const currentPageKey = getCleanPageKey(window.location.pathname);
    
    document.querySelectorAll('.top-navbar .nav-links a').forEach(link => {
        link.classList.remove('active');
        const linkPageKey = getCleanPageKey(link.getAttribute('href'));
        
        if (currentPageKey === linkPageKey) {
            link.classList.add('active');
        } else if (currentPageKey === 'customer-details' && linkPageKey === 'customers') {
            link.classList.add('active');
        } else if (currentPageKey === 'order_details' && linkPageKey === 'sales') {
            link.classList.add('active');
        }
    });
}

function toggleDarkModeHandler() {
    document.body.classList.toggle('dark-mode');
    const darkActive = document.body.classList.contains('dark-mode');
    try { localStorage.setItem('crm_dark_mode', darkActive ? 'true' : 'false'); } catch(e) {}
    
    const icon = document.querySelector('#darkModeToggle i');
    if (icon) {
        if (darkActive) { icon.classList.replace('fa-moon', 'fa-sun'); }
        else { icon.classList.replace('fa-sun', 'fa-moon'); }
    }
}

function initDarkMode() {
    const toggleBtn = document.getElementById('darkModeToggle');
    if (!toggleBtn) return;
    
    const icon = toggleBtn.querySelector('i');
    let isDark = false;
    try { isDark = localStorage.getItem('crm_dark_mode') === 'true'; } catch(e) {}
    if (isDark) {
        document.body.classList.add('dark-mode');
        if (icon) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); }
    }

    toggleBtn.removeEventListener('click', toggleDarkModeHandler);
    toggleBtn.addEventListener('click', toggleDarkModeHandler);
}

// ==========================================
// محرك التنبيهات الفوري (Instant Notifications Engine)
// ==========================================

function getReadNotifications() {
    try {
        const raw = localStorage.getItem(READ_NOTIFICATIONS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch(e) {
        return [];
    }
}

function markNotificationAsRead(id) {
    if (!id) return;
    try {
        const currentRead = getReadNotifications();
        if (!currentRead.includes(id)) {
            currentRead.push(id);
            localStorage.setItem(READ_NOTIFICATIONS_KEY, JSON.stringify(currentRead));
        }
    } catch(e) {}
    refreshNotifications();
}

function markAllNotificationsAsRead() {
    try {
        const allIds = currentNotificationsList.map(n => n.id);
        const currentRead = getReadNotifications();
        const merged = Array.from(new Set([...currentRead, ...allIds]));
        localStorage.setItem(READ_NOTIFICATIONS_KEY, JSON.stringify(merged));
    } catch(e) {}
    refreshNotifications();
}

function getStoredJsonArray(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') return Object.values(parsed);
        return [];
    } catch(e) {
        return [];
    }
}

export function refreshNotifications() {
    const customers = getStoredJsonArray('crm_customers');
    const opportunities = getStoredJsonArray('asgate_opportunities_local_cache_v1');
    const visits = getStoredJsonArray('asgate_visits_local_cache_v1');
    const reminders = getStoredJsonArray('asgate_reminders_data_v1');
    const sales = getStoredJsonArray('asgate_sales_db');
    const readIds = getReadNotifications();

    const calculation = calculateCrmNotifications({
        customers,
        opportunities,
        visits,
        reminders,
        sales,
        readNotificationIds: readIds,
        now: new Date()
    });

    currentNotificationsList = calculation.notifications;

    // تحديث الشارة الحمراء على الكرة الأرضية
    const badgeEl = document.getElementById('notificationBadge');
    if (badgeEl) {
        if (calculation.unreadCount > 0) {
            badgeEl.innerText = calculation.unreadCount > 99 ? '99+' : String(calculation.unreadCount);
            badgeEl.style.display = 'flex';
        } else {
            badgeEl.style.display = 'none';
        }
    }

    // تحديث العدادات الداخلية
    const totalCountEl = document.getElementById('notifCountTotalBadge');
    if (totalCountEl) totalCountEl.innerText = String(currentNotificationsList.length);

    const tabTodayEl = document.getElementById('tabCountToday');
    if (tabTodayEl) tabTodayEl.innerText = calculation.todayCount > 0 ? `(${calculation.todayCount})` : '';

    const tabUnreadEl = document.getElementById('tabCountUnread');
    if (tabUnreadEl) tabUnreadEl.innerText = calculation.unreadCount > 0 ? `(${calculation.unreadCount})` : '';

    renderNotificationsList();
}

function renderNotificationsList() {
    const listEl = document.getElementById('notificationsList');
    if (!listEl) return;

    let filtered = currentNotificationsList;
    if (currentNotificationFilter === 'today') {
        filtered = currentNotificationsList.filter(n => n.isToday);
    } else if (currentNotificationFilter === 'unread') {
        filtered = currentNotificationsList.filter(n => !n.isRead);
    } else if (currentNotificationFilter !== 'all') {
        filtered = currentNotificationsList.filter(n => n.category === currentNotificationFilter);
    }

    if (filtered.length === 0) {
        let emptyMsg = 'لا توجد تنبيهات حالياً';
        if (currentNotificationFilter === 'today') emptyMsg = 'لا توجد مهام أو مواعيد مجدولة لليوم';
        if (currentNotificationFilter === 'unread') emptyMsg = 'تمت قراءة جميع التنبيهات بنجاح';
        if (currentNotificationFilter === 'customer') emptyMsg = 'جميع العملاء تمت متابعتهم خلال الشهر الحالي';

        listEl.innerHTML = `
            <div class="notifications-empty">
                <i class="fas fa-bell-slash"></i>
                <span>${emptyMsg}</span>
            </div>
        `;
        return;
    }

    listEl.innerHTML = filtered.map(item => {
        let iconClass = 'fas fa-bell';
        let wrapClass = 'icon-wrap-reminder';

        if (item.category === 'opportunity') {
            iconClass = 'fas fa-lightbulb';
            wrapClass = 'icon-wrap-opportunity';
        } else if (item.category === 'customer') {
            iconClass = 'fas fa-users';
            wrapClass = 'icon-wrap-customer';
        } else if (item.category === 'visit') {
            iconClass = 'fas fa-map-marker-alt';
            wrapClass = 'icon-wrap-visit';
        } else if (item.category === 'sale') {
            iconClass = 'fas fa-shopping-cart';
            wrapClass = 'icon-wrap-sale';
        }

        return `
            <div class="notification-item ${item.isRead ? 'read' : 'unread'}" data-id="${escapeHTML(item.id)}" data-url="${escapeHTML(item.url)}">
                ${!item.isRead ? '<span class="unread-dot" title="غير مقروء"></span>' : ''}
                <div class="notification-icon-wrap ${wrapClass}">
                    <i class="${iconClass}"></i>
                </div>
                <div class="notification-content">
                    <div class="notif-top-row">
                        <span class="notif-title" title="${escapeHTML(item.title)}">${escapeHTML(item.title)}</span>
                        <span class="notif-badge-pill ${item.badgeClass}">${escapeHTML(item.badgeText)}</span>
                    </div>
                    <div class="notif-message">${escapeHTML(item.message)}</div>
                    <div class="notif-footer-row">
                        <span><i class="far fa-calendar-alt"></i> ${escapeHTML(item.date)}</span>
                        <span class="notif-action-text">${escapeHTML(item.actionText)} <i class="fas fa-chevron-left" style="font-size:9px;"></i></span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // إضافة مستمعي النقر لكل إشعار للتوجيه المباشر وتعليم الإشعار كمقروء
    listEl.querySelectorAll('.notification-item').forEach(el => {
        el.addEventListener('click', (e) => {
            const notifId = el.getAttribute('data-id');
            const targetUrl = el.getAttribute('data-url');
            if (notifId) markNotificationAsRead(notifId);
            const dropdown = document.getElementById('notificationsDropdown');
            if (dropdown) dropdown.classList.remove('show');
            const globeBtn = document.getElementById('globeNotificationBtn');
            if (globeBtn) globeBtn.classList.remove('active');
            
            if (targetUrl) {
                const currentPath = window.location.pathname.split('/').pop().replace('.html', '').replace('./', '') || 'index';
                const targetPath = targetUrl.split('?')[0].replace('.html', '').replace('./', '') || 'index';
                const params = new URLSearchParams(targetUrl.split('?')[1] || '');
                const highlightVal = params.get('highlight');

                if (currentPath === targetPath && highlightVal && typeof window.triggerElementHighlight === 'function') {
                    const didHighlight = window.triggerElementHighlight(highlightVal, true);
                    if (!didHighlight) {
                        window.location.href = targetUrl;
                    }
                } else {
                    window.location.href = targetUrl;
                }
            }
        });
    });
}

function positionNotificationsDropdown() {
    const dropdown = document.getElementById('notificationsDropdown');
    const globeBtn = document.getElementById('globeNotificationBtn');
    if (!dropdown || !globeBtn) return;

    dropdown.style.left = '0';
    dropdown.style.right = 'auto';

    const rect = dropdown.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

    if (rect.right > viewportWidth - 10) {
        const overflow = rect.right - (viewportWidth - 10);
        dropdown.style.left = `-${overflow}px`;
    }
    const updated = dropdown.getBoundingClientRect();
    if (updated.left < 10) {
        dropdown.style.left = '0';
        dropdown.style.right = 'auto';
    }
}

function initNotificationsComponent() {
    const globeBtn = document.getElementById('globeNotificationBtn');
    const dropdown = document.getElementById('notificationsDropdown');
    const markAllBtn = document.getElementById('markAllReadBtn');

    if (globeBtn && dropdown) {
        globeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.toggle('show');
            globeBtn.classList.toggle('active', isOpen);
            if (isOpen) {
                // إغلاق نتائج البحث إذا كانت مفتوحة وضبط محاذاة القائمة بدقة
                const searchRes = document.getElementById('searchResults');
                if (searchRes) searchRes.classList.remove('show');
                positionNotificationsDropdown();
                refreshNotifications();
            }
        });

        dropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    if (markAllBtn) {
        markAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            markAllNotificationsAsRead();
        });
    }

    // أزرار التبويبات داخل قائمة الإشعارات
    document.querySelectorAll('.notif-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.notif-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentNotificationFilter = tab.getAttribute('data-filter') || 'all';
            renderNotificationsList();
        });
    });

    // إغلاق القائمة عند النقر في الخارج
    document.addEventListener('click', (e) => {
        if (dropdown && !e.target.closest('.nav-notifications-container')) {
            dropdown.classList.remove('show');
            if (globeBtn) globeBtn.classList.remove('active');
        }
    });

    // تحديث أولي ومستمر للتنبيهات
    refreshNotifications();
    window.addEventListener('storage', refreshNotifications);
    setInterval(refreshNotifications, 20000); // تحديث دوري كل 20 ثانية
}

// ==========================================
// البحث الشامل
// ==========================================

function getLocalSearchIndex() {
    const allData = [];

    // 1. العملاء
    try {
        const custs = JSON.parse(localStorage.getItem('crm_customers') || '[]');
        custs.forEach(c => {
            allData.push({
                type: 'customer',
                title: c.comp || c.name || 'عميل',
                code: c.code || '',
                details: `المسؤول: ${c.mgr || '-'} | هاتف: ${c.mob || '-'} | المدينة: ${c.city || '-'}`,
                url: `customer-details.html?code=${encodeURIComponent(c.code || '')}`,
                searchTokens: [c.comp, c.name, c.mgr, c.mob, c.email, c.city, c.code, c.cr1, c.cr].join(' ').toLowerCase()
            });
        });
    } catch(e){}

    // 2. الزيارات
    try {
        const rawVisits = localStorage.getItem('asgate_visits_local_cache_v1');
        if (rawVisits) {
            const parsed = JSON.parse(rawVisits);
            const visits = Array.isArray(parsed) ? parsed : Object.values(parsed);
            visits.forEach(v => {
                allData.push({
                    type: 'visit',
                    title: v.comp || v.mgr || 'زيارة',
                    code: v.id || '',
                    details: `تاريخ: ${v.visitDate || '-'} | الحالة: ${v.status || '-'} | المسؤول: ${v.mgr || '-'}`,
                    url: `visits.html`,
                    searchTokens: [v.comp, v.mgr, v.mob, v.curServ, v.status, v.owner].join(' ').toLowerCase()
                });
            });
        }
    } catch(e){}

    // 3. الفرص البيعية
    try {
        const rawOpps = localStorage.getItem('asgate_opportunities_local_cache_v1');
        if (rawOpps) {
            const parsed = JSON.parse(rawOpps);
            const opps = Array.isArray(parsed) ? parsed : Object.values(parsed);
            opps.forEach(o => {
                allData.push({
                    type: 'opportunity',
                    title: o.comp || o.mgr || 'فرصة بيعية',
                    code: o.id || '',
                    details: `قيمة: ${o.oppValue || 0} ر.س | الحالة: ${o.status || '-'} | المسؤول: ${o.mgr || '-'}`,
                    url: `opportunities.html`,
                    searchTokens: [o.comp, o.mgr, o.mob, o.curServ, o.status, o.owner].join(' ').toLowerCase()
                });
            });
        }
    } catch(e){}

    // 4. المبيعات
    try {
        const sales = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        sales.forEach(s => {
            allData.push({
                type: 'sale',
                title: `${s.type || 'طلب مبيعات'} - ${s.comp || ''}`,
                code: s.id ? `#${s.id}` : '',
                details: `الشركة: ${s.comp || '-'} | الحالة: ${s.status || '-'} | التاريخ: ${s.date || '-'}`,
                url: `order_details.html?id=${encodeURIComponent(s.id || '')}`,
                searchTokens: [s.id, s.type, s.comp, s.cr, s.status, s.owner].join(' ').toLowerCase()
            });
        });
    } catch(e){}

    // 5. التذكيرات
    try {
        const reminders = JSON.parse(localStorage.getItem('asgate_reminders_data_v1') || '[]');
        reminders.forEach((r) => {
            if (r.title || r.text) {
                allData.push({
                    type: 'reminder',
                    title: r.title || 'تذكير',
                    code: r.date || '',
                    details: `${(r.text || '').substring(0, 50)}...`,
                    url: `reminders.html`,
                    searchTokens: [r.title, r.text, r.date].join(' ').toLowerCase()
                });
            }
        });
    } catch(e){}

    return allData;
}

function handleSearchInput(e) {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim().toLowerCase();
    const resultsContainer = document.getElementById('searchResults');
    if (!resultsContainer) return;

    if (query.length < 2) { 
        resultsContainer.classList.remove('show'); 
        return; 
    }
    
    searchTimeout = setTimeout(() => { 
        performGlobalSearch(query, resultsContainer); 
    }, 150);
}

function handleDocumentClick(e) {
    const resultsContainer = document.getElementById('searchResults');
    if (resultsContainer && !e.target.closest('.nav-search-container')) {
        resultsContainer.classList.remove('show');
    }
}

function initGlobalSearch() {
    const globalInput = document.getElementById('globalSearchInput');
    if (!globalInput) return;

    globalInput.removeEventListener('input', handleSearchInput);
    globalInput.addEventListener('input', handleSearchInput);

    document.removeEventListener('click', handleDocumentClick);
    document.addEventListener('click', handleDocumentClick);
}

function performGlobalSearch(query, container) {
    const searchIndex = getLocalSearchIndex();
    const matched = searchIndex.filter(item => item.searchTokens.includes(query)).slice(0, 10);
    renderSearchResults(matched, container, query);
}

function renderSearchResults(results, container, query) {
    container.innerHTML = '';
    if (results.length === 0) {
        container.innerHTML = `<div class="search-no-results">لا توجد نتائج مطابقة لـ "${escapeHTML(query)}"</div>`;
    } else {
        results.forEach(res => {
            let badgeClass = 'badge-customers'; 
            let badgeText = 'عميل';
            if (res.type === 'visit') { badgeClass = 'badge-visits'; badgeText = 'زيارة'; }
            if (res.type === 'opportunity') { badgeClass = 'badge-opportunities'; badgeText = 'فرصة'; }
            if (res.type === 'sale') { badgeClass = 'badge-sales'; badgeText = 'مبيعات'; }
            if (res.type === 'reminder') { badgeClass = 'badge-reminders'; badgeText = 'تذكير'; }
            
            const item = document.createElement('a');
            item.href = res.url;
            item.className = 'search-result-item';
            item.innerHTML = `
                <div class="result-header">
                    <span class="result-title">${escapeHTML(res.title)} ${res.code ? `<span style="color:#64748b; font-size:10px;">(${escapeHTML(res.code)})</span>` : ''}</span>
                    <span class="result-badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="result-details"><span>${escapeHTML(res.details)}</span></div>
            `;
            container.appendChild(item);
        });
    }
    container.classList.add('show');
}

function escapeHTML(str) { 
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])); 
}

function initNavbarComponent() {
    if (isNavbarInitialized) return;
    isNavbarInitialized = true;
    injectNavbarStyles();
    injectNavbarHTML();
    highlightActiveLink();
    initDarkMode();
    initGlobalSearch();
    initNotificationsComponent();
}

// دالة التظليل والوميض باللون الأصفر مرة واحدة فقط (يضيء ويطفئ مرة واحدة)
window.triggerElementHighlight = function(highlightId, force = false) {
    if (!highlightId) return false;
    const cleanId = String(highlightId).trim();
    if (!force && window._lastHighlightedId === cleanId && window._lastHighlightedElement && document.body.contains(window._lastHighlightedElement)) {
        return true;
    }
    const sanitized = cleanId.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    const findTarget = () => {
        // Direct ID or sanitized ID
        let el = document.getElementById(cleanId) || document.getElementById(sanitized);
        if (el) return el;

        // row- prefix
        el = document.getElementById('row-' + cleanId) || document.getElementById('row-' + sanitized);
        if (el) return el;

        // data attributes across table rows and reminder cards
        el = document.querySelector(`tr[data-id="${cleanId}"]`) ||
             document.querySelector(`tr[data-firestore-id="${cleanId}"]`) ||
             document.querySelector(`tr[data-code="${cleanId}"]`) ||
             document.querySelector(`input.select-check[data-code="${cleanId}"]`)?.closest('tr') ||
             document.querySelector(`a.code-link[href*="code=${cleanId}"]`)?.closest('tr') ||
             document.querySelector(`.reminder-card[data-id="${cleanId}"]`) ||
             document.querySelector(`.reminder-card[data-index="${cleanId}"]`) ||
             document.querySelector(`[data-code="${cleanId}"]`);
        if (el) return el;

        // Search through all potential rows and cards
        const candidates = Array.from(document.querySelectorAll('#tableBody tr, #salesBody tr, .reminder-card, tr.customer-row, #customersTable tr'));
        for (const r of candidates) {
            if (r.id === cleanId || r.id === sanitized || r.dataset?.id === cleanId || r.dataset?.firestoreId === cleanId || r.dataset?.code === cleanId) {
                return r;
            }
            const codeInput = r.querySelector('[data-code]');
            if (codeInput && (codeInput.dataset.code === cleanId || codeInput.value === cleanId)) {
                return r;
            }
            if (cleanId.length >= 3 && r.innerText && r.innerText.includes(cleanId)) {
                return r;
            }
        }

        if (window.location.pathname.includes('customer-details')) {
            const pageCard = document.querySelector('.section-card') || document.querySelector('.client-title-block');
            if (pageCard) return pageCard;
        }
        return null;
    };

    const targetEl = findTarget();
    if (targetEl) {
        window._lastHighlightedId = cleanId;
        window._lastHighlightedElement = targetEl;

        // If row is hidden by filtering, reveal it
        if (targetEl.style.display === 'none') {
            targetEl.style.display = '';
        }

        // Accurately center within .table-wrapper if parent exists
        const wrapper = targetEl.closest('.table-wrapper') || document.querySelector('.table-wrapper');
        if (wrapper) {
            const wrapperRect = wrapper.getBoundingClientRect();
            const elRect = targetEl.getBoundingClientRect();
            const targetScrollTop = wrapper.scrollTop + (elRect.top - wrapperRect.top) - (wrapper.clientHeight / 2) + (elRect.height / 2);
            wrapper.scrollTo({ top: Math.max(0, Math.round(targetScrollTop)), behavior: 'smooth' });
        }

        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        const animClass = (targetEl.classList.contains('reminder-card') || targetEl.classList.contains('section-card') || targetEl.classList.contains('client-title-block')) ? 'highlight-pulse-card' : 'highlight-pulse-row';
        targetEl.classList.remove(animClass);
        void targetEl.offsetWidth; // Re-trigger reflow
        targetEl.classList.add(animClass);

        // تفعيل الوميض باللون الأصفر مرة واحدة فقط (يضيء ويطفئ مرة واحدة)
        const childInputs = Array.from(targetEl.querySelectorAll('td, input, select, textarea, .excel-input, span.value, a.code-link'));
        
        const setFlash = (isFlash, color, outline) => {
            if (isFlash) {
                targetEl.style.setProperty('background-color', color, 'important');
                targetEl.style.setProperty('outline', outline, 'important');
                childInputs.forEach(c => {
                    c.style.setProperty('background-color', color, 'important');
                    c.style.setProperty('color', '#713f12', 'important');
                });
            } else {
                targetEl.style.removeProperty('background-color');
                targetEl.style.removeProperty('outline');
                childInputs.forEach(c => {
                    c.style.removeProperty('background-color');
                    c.style.removeProperty('color');
                });
            }
        };

        // وميض أصفر مرة واحدة
        setFlash(true, '#FEF08A', '3px solid #EAB308');
        setTimeout(() => {
            // انطفاء وعودة كاملة للحالة الأصلية
            setFlash(false);
            targetEl.classList.remove(animClass);
        }, 1000);

        return true;
    }
    return false;
};

function initBulkActionWrapperHover() {
    const attachHover = () => {
        document.querySelectorAll('.bulk-action-wrapper').forEach(wrapper => {
            if (!wrapper.dataset.hoverBound) {
                wrapper.dataset.hoverBound = 'true';
                wrapper.addEventListener('mouseleave', () => {
                    const menu = wrapper.querySelector('.dropdown-menu');
                    if (menu) menu.classList.remove('show');
                });
            }
        });
    };
    attachHover();
    setTimeout(attachHover, 500);
}

function checkGlobalUrlHighlight() {
    const urlParams = new URLSearchParams(window.location.search);
    const highlightId = urlParams.get('highlight');
    if (!highlightId) return;

    let attempts = 0;
    const pollInterval = setInterval(() => {
        attempts++;
        const success = window.triggerElementHighlight(highlightId);
        if (success || attempts >= 25) {
            clearInterval(pollInterval);
        }
    }, 280);
}

export function initNavbar() { 
    initNavbarComponent(); 
    checkGlobalUrlHighlight();
    initBulkActionWrapperHover();
}

// Expose refresh on window for components modifying data
if (typeof window !== 'undefined') {
    window.refreshCrmNotifications = refreshNotifications;
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initNavbarComponent();
        checkGlobalUrlHighlight();
        initBulkActionWrapperHover();
    });
} else {
    initNavbarComponent();
    checkGlobalUrlHighlight();
    initBulkActionWrapperHover();
}
