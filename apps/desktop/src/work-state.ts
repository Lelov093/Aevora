import states from '../../../packages/protocol/work-states.json';
export const taskNames:Record<string,string>=Object.fromEntries(Object.entries(states.task).map(([key,value])=>[key,value.label]));
export const executionNames:Record<string,string>=Object.fromEntries(Object.entries(states.execution).map(([key,value])=>[key,value.label]));
export type WorkActivityItem={kind:'task'|'execution';id:string;title:string;state:string;label:string;category:'working'|'attention'|'waiting'|'paused'|'finished';goal_id:string|null;conversation_id:string|null};
export type WorkActivity={primary:WorkActivityItem|null;items:WorkActivityItem[];omitted?:number};
