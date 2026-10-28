// FeatureTree 文档存储：包络（revision / origin / history）+ 操作 + 乐观锁 + 原子事务。
// 流程固定：校验 → 编译 → 重建钩子 → 发布新版本 → 通知订阅者；任一步失败则版本不变。
import { createHash } from 'node:crypto';
import { validateDoc, checkPanelEdit, compileOps } from './validate.mjs';

export function clone(v) { return JSON.parse(JSON.stringify(v)); }

// 重建钩子（v1 占位实现，非 OCCT 真重建）：编译算子 + 指纹。
// 真实 OCCT/build123d 重建由后续 cadgen 侧车桥接替换本函数；
// 在此之前，服务诚实地只保证“编译通过 + 指纹变化”，不宣称已生成 BRep。
export function rebuild(doc) {
  const ops = compileOps(doc);
  const fingerprint = createHash('sha256').update(JSON.stringify(ops)).digest('hex').slice(0, 16);
  return { ok: true, ops, fingerprint };
}

export class Store {
  constructor(initialDoc) {
    this.doc = clone(initialDoc);
    this.revision = 0;
    this.history = [];
    this.snapshots = [clone(this.doc)]; // snapshots[revision] = 该版本文档全文
    this.listeners = new Set();
    const errs = validateDoc(this.doc);
    if (errs.length) throw new Error('初始文档校验失败：' + errs.join('；'));
  }
  envelope() {
    return { documentId: 'demo-adapter', kind: 'part', revision: this.revision, doc: clone(this.doc), history: clone(this.history) };
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(change) { for (const fn of this.listeners) fn(change); }

  // 核心写入口：fn(docDraft) 做修改；随后整树校验 + 重建，失败则丢弃草稿。
  commit(expectedRevision, actor, operation, featureIds, fn) {
    if (expectedRevision !== this.revision) {
      return { error: 'CONFLICT_STALE_REVISION', message: `版本过期：期望 ${expectedRevision}，当前 ${this.revision}`, current: this.envelope() };
    }
    const draft = clone(this.doc);
    const opErr = fn(draft);
    if (opErr) return { error: 'VALIDATION_FAILED', message: opErr };
    const errs = validateDoc(draft);
    if (errs.length) return { error: 'VALIDATION_FAILED', message: errs.join('；') };
    const rb = rebuild(draft);
    if (!rb.ok) return { error: 'REBUILD_FAILED', message: rb.message || '重建失败' };
    const before = this.revision;
    this.doc = draft;
    this.doc.updatedAt = new Date().toISOString().replace('Z', '+08:00');
    this.revision += 1;
    this.snapshots[this.revision] = clone(this.doc);
    const entry = { revision: this.revision, beforeRevision: before, timestamp: this.doc.updatedAt, actor, operation, featureIds, fingerprint: rb.fingerprint };
    this.history.push(entry);
    const env = this.envelope();
    this.emit({ documentId: env.documentId, revision: env.revision, changedFeatureIds: featureIds, actor });
    return env;
  }

  applyOperation(body) {
    const { expectedRevision, actor = 'manual', operation } = body;
    const actorLabel = actor === 'agent' ? `agent:${body.agentId || 'unknown'}` : 'manual';
    switch (operation) {
      case 'createFeature': {
        const f = body.feature;
        if (!f || typeof f.id !== 'string' || !f.id.trim()) return { error: 'VALIDATION_FAILED', message: '缺少必填参数：特征.id' };
        if (this.doc.features.some(x => x.id === f.id)) return { error: 'DUPLICATE_ID', message: `id「${f.id}」已存在` };
        return this.commit(expectedRevision, actorLabel, operation, [f.id], (d) => { d.features.push(clone(f)); return null; });
      }
      case 'updateFeatureParams': {
        const f = this.doc.features.find(x => x.id === body.featureId);
        if (!f) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        for (const [k, v] of Object.entries(body.patch || {})) {
          const e = checkPanelEdit(f, k, v);
          if (e) return { error: e.startsWith('未知字段') ? 'UNKNOWN_FIELD' : 'VALIDATION_FAILED', message: e };
        }
        return this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => {
          const t = d.features.find(x => x.id === body.featureId);
          Object.assign(t.params, clone(body.patch)); return null;
        });
      }
      case 'renameFeature': {
        if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'VALIDATION_FAILED', message: 'name 必须是非空字符串' };
        if (!this.doc.features.some(x => x.id === body.featureId)) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        return this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => { d.features.find(x => x.id === body.featureId).name = body.name; return null; });
      }
      case 'reorderFeature': {
        const from = this.doc.features.findIndex(x => x.id === body.featureId);
        if (from === -1) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        return this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => {
          const [m] = d.features.splice(from, 1);
          const idx = Math.max(0, Math.min(body.targetIndex ?? 0, d.features.length));
          d.features.splice(idx, 0, m); return null;
        });
      }
      case 'setSuppressed': {
        if (typeof body.suppressed !== 'boolean') return { error: 'VALIDATION_FAILED', message: 'suppressed 必须是布尔值' };
        if (!this.doc.features.some(x => x.id === body.featureId)) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        return this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => { d.features.find(x => x.id === body.featureId).suppressed = body.suppressed; return null; });
      }
      case 'deleteFeature': {
        if (!this.doc.features.some(x => x.id === body.featureId)) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        return this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => { d.features = d.features.filter(x => x.id !== body.featureId); return null; });
      }
      case 'applyTransaction': {
        const ops = body.operations || [];
        // 事务在单次 commit 内顺序执行子操作，任一失败整单回滚（草稿丢弃）。
        return this.commit(expectedRevision, actorLabel, operation, ops.map(o => o.featureId).filter(Boolean), (d) => {
          for (const op of ops) {
            if (op.operation === 'updateFeatureParams') {
              const t = d.features.find(x => x.id === op.featureId);
              if (!t) return `找不到特征：${op.featureId}`;
              for (const [k, v] of Object.entries(op.patch || {})) {
                const e = checkPanelEdit(t, k, v);
                if (e) return e;
              }
              Object.assign(t.params, clone(op.patch));
            } else if (op.operation === 'setSuppressed') {
              const t = d.features.find(x => x.id === op.featureId);
              if (!t) return `找不到特征：${op.featureId}`;
              t.suppressed = op.suppressed;
            } else return `事务不支持的操作：${op.operation}`;
          }
          return null;
        });
      }
      default:
        return { error: 'VALIDATION_FAILED', message: `未知操作：${operation}` };
    }
  }

  undo(expectedRevision, actor = 'manual', steps = 1) {
    // undo 本身也是一次写操作：带 expectedRevision，经过校验与重建，产生新 revision；
    // 历史不删除，undo 记录进 history，目标是 snapshots[revision - steps] 的全文。
    if (expectedRevision !== this.revision) {
      return { error: 'CONFLICT_STALE_REVISION', message: `版本过期：期望 ${expectedRevision}，当前 ${this.revision}`, current: this.envelope() };
    }
    const target = this.revision - Math.max(1, steps);
    if (target < 0 || !this.snapshots[target]) return { error: 'NOT_FOUND', message: `没有可撤销到的版本：${target}` };
    const restored = clone(this.snapshots[target]);
    const errs = validateDoc(restored);
    if (errs.length) return { error: 'VALIDATION_FAILED', message: errs.join('；') };
    const rb = rebuild(restored);
    if (!rb.ok) return { error: 'REBUILD_FAILED', message: rb.message || '重建失败' };
    const before = this.revision;
    this.doc = restored;
    this.doc.updatedAt = new Date().toISOString().replace('Z', '+08:00');
    this.revision += 1;
    this.snapshots[this.revision] = clone(this.doc);
    this.history.push({ revision: this.revision, beforeRevision: before, timestamp: this.doc.updatedAt, actor, operation: 'undo', featureIds: [], fingerprint: rb.fingerprint, undoTarget: target });
    const env = this.envelope();
    this.emit({ documentId: env.documentId, revision: env.revision, changedFeatureIds: [], actor });
    return env;
  }
}
