import { Router, Request, Response } from 'express';
import { generateToken } from '../../lib/auth';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  const { password } = req.body;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const token = generateToken();
  res.json({ token });
});

export default router;
