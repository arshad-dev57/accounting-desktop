/**
 * Push / pull POS operational accounts with the ERP via /api/pos/accounts/*.
 */
const localDb = require('./local-db.cjs');
const posApi = require('./pos-api.cjs');

async function pushAccountsQueue(accessToken, { retryFailed = false } = {}) {
  const pending = localDb.getPendingAccounts({ retryFailed });
  if (!pending.length) {
    return { success: true, pushed: 0, skipped: 0, failed: 0, results: [] };
  }

  const batch = pending.slice(0, 100).map((r) => ({
    clientId: r.clientId || r.id,
    id: r.id,
    type: r.type,
    amount: r.amount,
    date: r.date || r.transactionDate,
    transactionDate: r.transactionDate || r.date,
    paymentMethod: r.paymentMethod,
    category: r.category,
    description: r.description || r.notes,
    notes: r.notes,
    partyName: r.partyName,
    partyId: r.partyId,
    direction: r.direction,
    sourceRef: r.sourceRef,
    locationId: r.locationId,
    expectedCash: r.expectedCash,
    actualCash: r.actualCash,
    difference: r.difference,
    updatedAt: r.updatedAt,
  }));

  const res = await posApi.syncPosAccounts(accessToken, { records: batch });
  if (!res.success) {
    const offline = /reach|network|ECONN|ENOTFOUND|offline|abort/i.test(String(res.message || ''));
    return {
      success: false,
      offline: offline || res.status === 0,
      message: res.message || 'Accounts push failed',
      pushed: 0,
      failed: batch.length,
      results: [],
    };
  }

  const data = res.data || {};
  const results = Array.isArray(data.results) ? data.results : [];
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  const doneIds = [];

  for (const r of results) {
    const id = r.clientId;
    if (!id) continue;
    if (r.status === 'success' || r.status === 'skipped') {
      if (r.status === 'success') pushed += 1;
      else skipped += 1;
      localDb.patchAccountsEntry(id, {
        syncStatus: 'synced',
        cloudId: r.cloudId || null,
        lastError: null,
      });
      doneIds.push(id);
    } else {
      failed += 1;
      const cur = localDb.getAccountsQueue().find((x) => String(x.id) === String(id));
      localDb.patchAccountsEntry(id, {
        syncStatus: 'failed',
        failCount: (Number(cur?.failCount) || 0) + 1,
        lastError: r.message || 'Failed',
      });
    }
  }

  if (doneIds.length) localDb.removeFromAccountsQueue(doneIds);
  localDb.saveAccountsSyncMeta({ lastPushAt: new Date().toISOString(), lastError: failed ? 'Some accounts failed' : null });

  return {
    success: failed === 0,
    pushed: data.pushed != null ? data.pushed : pushed,
    skipped: data.skipped != null ? data.skipped : skipped,
    failed: data.failed != null ? data.failed : failed,
    results,
    message: res.message || '',
  };
}

async function pullAccountsFromCloud(accessToken) {
  const meta = localDb.getAccountsSyncMeta();
  const since = meta.lastGetAt || new Date(Date.now() - 30 * 86400000).toISOString();
  const res = await posApi.listSyncedPosAccounts(accessToken, since);
  if (!res.success) {
    const offline = /reach|network|ECONN|ENOTFOUND|offline|abort/i.test(String(res.message || ''));
    return {
      success: false,
      offline: offline || res.status === 0,
      message: res.message || 'Accounts get failed',
      imported: 0,
    };
  }

  const rows = Array.isArray(res.data) ? res.data : [];
  const ledger = localDb.getAccountsLedger();
  let imported = 0;
  for (const row of rows) {
    const clientId = String(row.clientId || '').trim();
    if (!clientId) continue;
    const exists = ledger.some(
      (l) => String(l.id) === clientId || String(l.cloudId || '') === String(row.cloudId || '')
    );
    if (exists) {
      // Mark local as synced if we have a matching pending id
      const local = ledger.find((l) => String(l.id) === clientId);
      if (local && local.syncStatus !== 'synced') {
        localDb.patchAccountsEntry(local.id, { syncStatus: 'synced', cloudId: row.cloudId });
        localDb.removeFromAccountsQueue([local.id]);
      }
      continue;
    }
    // Do not invent full local financial history from cloud refs alone —
    // only annotate sync awareness without deleting local-only rows.
    ledger.unshift({
      id: clientId,
      clientId,
      type: 'cloud_ref',
      amount: 0,
      date: row.date ? String(row.date).slice(0, 10) : new Date().toISOString().slice(0, 10),
      description: row.description || row.cloudNumber || 'Synced from cloud',
      syncStatus: 'synced',
      cloudId: row.cloudId,
      createdAt: row.updatedAt || new Date().toISOString(),
      updatedAt: row.updatedAt || new Date().toISOString(),
      fromCloud: true,
    });
    imported += 1;
  }
  if (imported) localDb.saveAccountsLedger(ledger.slice(0, 5000));
  localDb.saveAccountsSyncMeta({ lastGetAt: new Date().toISOString() });

  let mappings = null;
  try {
    const mapRes = await posApi.getPosAccountMappings(accessToken);
    if (mapRes.success) mappings = mapRes.data;
  } catch (_) { /* ignore */ }

  return {
    success: true,
    imported,
    mappings,
    message: `Accounts get: ${imported} cloud reference(s)`,
  };
}

module.exports = { pushAccountsQueue, pullAccountsFromCloud };
