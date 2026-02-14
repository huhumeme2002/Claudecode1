import { Router, Response } from 'express';
import { verifyApiKey } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.get('/', verifyApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const days = parseInt(req.query.days as string) || 7;
    const since = new Date(Date.now() - days * 86400_000);

    const rows: any[] = await prisma.$queryRaw`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(cost), 0) as cost,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*)::int as requests
      FROM usage_logs
      WHERE api_key_id = ${req.apiKey.id}
        AND created_at >= ${since}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;

    const chart = rows.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
      cost: Number(r.cost),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      requests: Number(r.requests),
    }));

    res.json({ chart });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
});

export default router;
