import { buildMetrics } from './sdrMetrics.js';
import { parseMetricWindow } from './sdrMetricWindow.js';
function filter(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128) throw new Error('invalid_filter');
  return value;
}
export function registerSdrMetricsRoutes(app, { pool, resolveVisibleMailboxes, metrics=buildMetrics }) {
  app.get('/api/sdr/metrics',async (req,res) => {
    if (!req.sdrUser?.sub) return res.status(401).json({error:'Unauthorized'});
    try {
      const now=new Date();
      const window=parseMetricWindow(req.query,now);
      const requested=filter(req.query.mailbox)?.toLowerCase();
      const source=filter(req.query.source);
      const sequence=filter(req.query.sequence);
      const allowed=[...new Set((await resolveVisibleMailboxes(req.sdrUser)).map(value => value.toLowerCase()))];
      if (requested && !allowed.includes(requested)) return res.status(403).json({error:'mailbox_not_visible'});
      res.json(await metrics(pool,{ window,visibleMailboxes:requested ? [requested] : allowed,source,sequence,now,
        includeCompanySales:req.sdrUser.role==='admin' }));
    } catch (error) {
      const invalid=['invalid_date','invalid_range','unsupported_timezone','invalid_filter'].includes(error.message);
      res.status(invalid ? 400 : 503).json({error:invalid ? error.message : 'metrics_unavailable'});
    }
  });
}
