import { Router } from 'express';
import { requireAuth } from '../../middleware/core.js';
import auth from './auth.js';
import dashboard from './dashboard.js';
import analytics from './analytics.js';
import leads from './leads.js';
import notifications from './notifications.js';
import cms from './cms.js';
import users from './users.js';

const r = Router();
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

r.use('/auth', auth);                 // login is public; the rest of auth.js guards itself
r.use(requireAuth);                   // everything below needs a valid session
r.use('/dashboard', dashboard);
r.use('/analytics', analytics);
r.use('/leads', leads);
r.use('/', notifications);            // /notifications, /search
r.use('/', cms);                      // /hero /services /industries /leaders /testimonials /announcements /faqs /jobs /blog /seo /settings /documents /uploads
r.use('/', users);                    // /users /activity /smtp  (Admin only)

export default r;
