import type {FastifyInstance} from 'fastify';
import type {Identity} from '../identity/service.js';
import {parse,z,uuid} from '../http/validation.js';
import {CalendarSync} from './sync.js';
import {DirectoryScheduling} from './scheduling.js';
import {FeishuMeetings} from './service.js';
export function feishuMeetingRoutes(app:FastifyInstance,identity:Identity){
 const service=new FeishuMeetings(identity),sync=new CalendarSync(identity);
 app.addHook('onReady',()=>sync.initialize());
 app.get('/api/v4/calendar-sync/status',r=>sync.status(r.actor));
 app.get('/api/v4/calendar-sync/inbox',r=>sync.inbox(r.actor));
 app.post('/api/v4/calendar-sync/run',r=>sync.requestRun(r.actor));
 const eventId=(p:unknown)=>parse(z.object({eventId:z.string().min(1).max(500)}),p).eventId;
 app.post('/api/v4/calendar-sync/events/:eventId/bind',r=>sync.bind(r.actor,eventId(r.params),r.body));
 app.post('/api/v4/calendar-sync/events/:eventId/resolve',r=>sync.resolve(r.actor,eventId(r.params),r.body));
 app.post('/api/v4/calendar-sync/interviews/:id/retry',r=>sync.retry(r.actor,parse(z.object({id:uuid}),r.params).id));
 app.get('/api/v4/interviews/:id/directory-schedule',r=>new DirectoryScheduling(identity).roster(r.actor,parse(z.object({id:uuid}),r.params).id));
 app.patch('/api/v4/interviews/:id/directory-schedule',r=>new DirectoryScheduling(identity).update(r.actor,parse(z.object({id:uuid}),r.params).id,r.body));
 app.post('/api/v4/interviews/directory-schedule',r=>new DirectoryScheduling(identity).create(r.actor,r.body));
 app.post('/api/v4/interviews/:id/feishu-calendar',r=>service.create(r.actor,parse(z.object({id:uuid}),r.params).id,r.body));
}
