
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const ALLOWED_CHANNELS = new Set([
  'window:minimize',
  'window:maximize',
  'window:close',
  'window:isMaximized',
  'auth:saveSession',
  'auth:getSession',
  'auth:clearSession',
  'auth:login',
  'auth:verifyOtp',
  'auth:resendOtp',
  'auth:openLogin',
  'auth:logout',
  'app:getInfo',
  'app:openExternal',
  'print:showDialog',
  'pos:listTerminals',
  'pos:getCurrentShift',
  'pos:getActiveShift',
  'pos:openShift',
  'pos:resumeShift',
  'pos:closeShift',
  'pos:searchProducts',
  'pos:completeSale',
  'pos:enterShift',
  'pos:enterSell',
  'pos:getShiftHistory',
  'pos:suspendShift',
  'pos:recordCashFlow',
  'pos:byBarcode',
        'pos:holdSale',
  'pos:getHeldSales',
  'pos:deleteHeldSale',
  'pos:syncOfflineSales',
  'pos:getSyncStatus',
  'pos:processReturn',
  'pos:listLocalSales',
  'pos:listLocalReturns',
  'pos:clearReturnsQueue',
  'pos:getShiftReport',
  'pos:getDailyReport',
  'pos:verifyManager',
  'pos:getCategories',
  'pos:searchCustomers',
  'pos:createCustomer',
  'pos:getCustomerCreditInfo',
  'pos:getReceiptSettings',
  'pos:getProfile',
  'pos:createTerminal',
  'pos:updateTerminal',
  'pos:deleteTerminal',
  'pos:reopenShift',
  'pos:listSales',
  'pos:getSale',
  'pos:voidSale',
  'pos:convertToInvoice',
  'pos:deleteAllSales',
  'pos:getAuditLogs',
  'pos:saveReceiptSettings',
  'pos:enterManagement',
  'pos:listLocations',
  'pos:syncMasterData',
  'pos:pushMasterData',
  'pos:syncBidirectional',
  'pos:getMasterSyncStatus',
  'pos:enterRegister',
  'pos:enterCategories',
  'catalog:list',
  'catalog:listSuppliers',
  'catalog:saveCategory',
  'catalog:deleteCategory',
  'catalog:saveSubcategory',
  'catalog:deleteSubcategory',
  'catalog:listProducts',
  'catalog:saveProduct',
  'catalog:deleteProduct',
  'pos:addStockIn',
  'pos:addStockOut',
  'pos:listStockMovements',
  'sales:getOrders',
  'sales:createOrder',
  'sales:updateStatus',
  'sales:cancelOrder',
  'sales:deleteOrder',
  'sales:enterSales',
  'customers:list',
  'customers:search',
  'products:list',
  'tax:getContext',
  'tax:refreshContext',
]);

function invoke(channel, payload) {
  if (!ALLOWED_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload);
}

function buildSeedScript(session) {
  if (!session?.accessToken) return '';
  const userJson =
    typeof session.user === 'string'
      ? session.user
      : session.user
        ? JSON.stringify(session.user)
        : '';
  return `(function(){
    try {
      localStorage.setItem('auth_token', ${JSON.stringify(session.accessToken)});
      localStorage.setItem('refresh_token', ${JSON.stringify(session.refreshToken || '')});
      ${userJson ? `localStorage.setItem('user', ${JSON.stringify(userJson)});` : ''}
      localStorage.setItem('has_subscription_access', '1');
    } catch (e) {}
  })();`;
}

function seedRendererSession() {
  try {
    if (typeof location === 'undefined' || location.protocol === 'file:') return;
    const session = ipcRenderer.sendSync('auth:getSessionSync');
    if (!session?.accessToken) return;

    try {
      localStorage.setItem('auth_token', session.accessToken);
      if (session.refreshToken) localStorage.setItem('refresh_token', session.refreshToken);
      if (session.user) {
        localStorage.setItem(
          'user',
          typeof session.user === 'string' ? session.user : JSON.stringify(session.user)
        );
      }
      localStorage.setItem('has_subscription_access', '1');
    } catch {
      // isolated world may throw; page world is set below
    }

    const script = buildSeedScript(session);
    if (script) {
      webFrame.executeJavaScript(script).catch(() => {});
    }
  } catch (err) {
    console.warn('[desktop preload] session seed failed', err?.message || err);
  }
}

seedRendererSession();
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', seedRendererSession);
}

contextBridge.exposeInMainWorld('bisonDesktop', {
  isDesktop: true,
  window: {
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:isMaximized'),
    onMaximizedChange: (callback) => {
      const listener = (_event, value) => callback(Boolean(value));
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
  },
  auth: {
    login: (email, password) => invoke('auth:login', { email, password }),
    verifyOtp: (email, otp) => invoke('auth:verifyOtp', { email, otp }),
    resendOtp: (email) => invoke('auth:resendOtp', { email }),
    openLogin: () => invoke('auth:openLogin'),
    saveSession: (session) => invoke('auth:saveSession', session),
    getSession: () => invoke('auth:getSession'),
    clearSession: () => invoke('auth:clearSession'),
    logout: () => invoke('auth:logout'),
    onExpired: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('auth:expired', listener);
      return () => ipcRenderer.removeListener('auth:expired', listener);
    },
    onCompanyInactive: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('auth:company-inactive', listener);
      return () => ipcRenderer.removeListener('auth:company-inactive', listener);
    },
  },
  pos: {
    listTerminals: () => invoke('pos:listTerminals'),
    listLocations: () => invoke('pos:listLocations'),
    getCurrentShift: () => invoke('pos:getCurrentShift'),
    getActiveShift: () => invoke('pos:getActiveShift'),
    openShift: (payload) => invoke('pos:openShift', payload),
    resumeShift: (shiftId) => invoke('pos:resumeShift', shiftId),
    closeShift: (payload) => invoke('pos:closeShift', payload),
    searchProducts: (query, locationId) =>
      invoke(
        'pos:searchProducts',
        query && typeof query === 'object' && !Array.isArray(query)
          ? query
          : { query, locationId }
      ),
    completeSale: (payload) => invoke('pos:completeSale', payload),
    enterShift: () => invoke('pos:enterShift'),
    enterSell: () => invoke('pos:enterSell'),
    // Expanded layout methods
    getShiftHistory: (paramsString) => invoke('pos:getShiftHistory', paramsString),
    suspendShift: (shiftId) => invoke('pos:suspendShift', shiftId),
    recordCashFlow: (payload) => invoke('pos:recordCashFlow', payload),
    byBarcode: (code, locationId) => invoke('pos:byBarcode', { code, locationId }),
    holdSale: (payload) => invoke('pos:holdSale', payload),
    getHeldSales: () => invoke('pos:getHeldSales'),
    deleteHeldSale: (id) => invoke('pos:deleteHeldSale', id),
        syncOfflineSales: () => invoke('pos:syncOfflineSales'),
    getSyncStatus: () => invoke('pos:getSyncStatus'),
    processReturn: (payload) => invoke('pos:processReturn', payload),
    listLocalSales: () => invoke('pos:listLocalSales'),
    listLocalReturns: () => invoke('pos:listLocalReturns'),
    clearReturnsQueue: () => invoke('pos:clearReturnsQueue'),
    getShiftReport: (shiftId) => invoke('pos:getShiftReport', shiftId),
    getDailyReport: (paramsString) => invoke('pos:getDailyReport', paramsString),
    verifyManager: (payload) => invoke('pos:verifyManager', payload),
    getCategories: (paramsString) => invoke('pos:getCategories', paramsString),
    searchCustomers: (q, limit) => invoke('pos:searchCustomers', { q, limit }),
    createCustomer: (payload) => invoke('pos:createCustomer', payload),
    getCustomerCreditInfo: (customerId) => invoke('pos:getCustomerCreditInfo', customerId),
    getReceiptSettings: () => invoke('pos:getReceiptSettings'),
    getProfile: () => invoke('pos:getProfile'),
    // POS Management / Admin APIs
    createTerminal: (body) => invoke('pos:createTerminal', body),
    updateTerminal: (id, body) => invoke('pos:updateTerminal', { id, body }),
    deleteTerminal: (id) => invoke('pos:deleteTerminal', id),
    reopenShift: (id) => invoke('pos:reopenShift', id),
    listSales: (paramsString) => invoke('pos:listSales', paramsString),
    getSale: (id) => invoke('pos:getSale', id),
    voidSale: (id, body) => invoke('pos:voidSale', { id, body }),
    convertToInvoice: (id, body) => invoke('pos:convertToInvoice', { id, body }),
    deleteAllSales: () => invoke('pos:deleteAllSales'),
    getAuditLogs: (paramsString) => invoke('pos:getAuditLogs', paramsString),
    saveReceiptSettings: (body) => invoke('pos:saveReceiptSettings', body),
    enterManagement: () => invoke('pos:enterManagement'),
    syncMasterData: (payload) => invoke('pos:syncMasterData', payload),
    syncBidirectional: () => invoke('pos:syncBidirectional'),
    pushMasterData: () => invoke('pos:pushMasterData'),
    getMasterSyncStatus: () => invoke('pos:getMasterSyncStatus'),
    enterRegister: () => invoke('pos:enterRegister'),
    enterCategories: () => invoke('pos:enterCategories'),
    addStockIn: (payload) => invoke('pos:addStockIn', payload),
    addStockOut: (payload) => invoke('pos:addStockOut', payload),
    listStockMovements: (paramsString) => invoke('pos:listStockMovements', paramsString),
  },
  catalog: {
    list: () => invoke('catalog:list'),
    listSuppliers: () => invoke('catalog:listSuppliers'),
    saveCategory: (payload) => invoke('catalog:saveCategory', payload),
    deleteCategory: (id) => invoke('catalog:deleteCategory', id),
    saveSubcategory: (payload) => invoke('catalog:saveSubcategory', payload),
    deleteSubcategory: (id) => invoke('catalog:deleteSubcategory', id),
    listProducts: () => invoke('catalog:listProducts'),
    saveProduct: (payload) => invoke('catalog:saveProduct', payload),
    deleteProduct: (id) => invoke('catalog:deleteProduct', id),
  },
  sales: {
    getOrders: (params) => invoke('sales:getOrders', params),
    createOrder: (data) => invoke('sales:createOrder', data),
    updateStatus: (id, status, reason) => invoke('sales:updateStatus', { id, status, reason }),
    cancelOrder: (id, reason) => invoke('sales:cancelOrder', { id, reason }),
    deleteOrder: (id) => invoke('sales:deleteOrder', { id }),
    enterSales: () => invoke('sales:enterSales'),
  },
  customers: {
    list: (params) => invoke('customers:list', params),
    search: (q, limit) => invoke('customers:search', { q, limit }),
  },
  products: {
    list: (params) => invoke('products:list', params),
  },
  tax: {
    getContext: () => invoke('tax:getContext'),
    refreshContext: () => invoke('tax:refreshContext'),
  },
  app: {
    getInfo: () => invoke('app:getInfo'),
    openExternal: (url) => invoke('app:openExternal', url),
  },
  print: {
    showDialog: (options) => invoke('print:showDialog', options),
  },
});
