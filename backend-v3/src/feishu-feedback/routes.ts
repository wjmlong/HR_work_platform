import type {FastifyInstance} from 'fastify';
import type {Identity} from '../identity/service.js';
import {parse,z,uuid} from '../http/validation.js';
import {InterviewFeedback} from './service.js';
export function registerInterviewFeedbackRoutes(app:FastifyInstance,identity:Identity){
 const service=new InterviewFeedback(identity),id=(p:unknown)=>parse(z.object({id:uuid}),p).id;
 app.get('/api/v4/interviews/:id/feishu-feedback',r=>service.status(r.actor,id(r.params)));
 app.post('/api/v4/interviews/:id/feishu-feedback',r=>service.send(r.actor,id(r.params),r.body));
}
