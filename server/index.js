import path from 'node:path';
import express from 'express';
import { ROOT, config } from './config.js';
import { seedIfEmpty } from './seed.js';
import { markInterrupted } from './services/pipeline.js';
import { markPrepInterrupted } from './services/prepare.js';
import { api } from './routes.js';

seedIfEmpty();
markInterrupted();
markPrepInterrupted();

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api', api);

// Front-end libraries rechtstreeks uit node_modules (geen CDN nodig, werkt offline)
const nm = (p) => path.join(ROOT, 'node_modules', p);
app.use('/vendor/bootstrap', express.static(nm('bootstrap/dist')));
app.use('/vendor/bootstrap-icons', express.static(nm('bootstrap-icons/font')));
app.use('/vendor/jquery', express.static(nm('jquery/dist')));
app.use('/vendor/datatables', express.static(nm('datatables.net/js')));
app.use('/vendor/datatables-bs5', express.static(nm('datatables.net-bs5')));
// Eigen HTML/JS/CSS: altijd opnieuw valideren (anders houdt de browser of Cloudflare na een update
// oude scripts vast naast nieuwe pagina's). De vendor-bibliotheken hierboven mogen wel gecachet worden.
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.listen(config.port, () => {
  console.log(`Transcraiber draait op http://localhost:${config.port}${config.mockLlm ? ' (MOCK_LLM)' : ''}`);
});
