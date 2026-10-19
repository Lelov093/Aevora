import {useId} from 'react';
import {NumberField,Select} from './controls';

export const budgetLabel=(value:number|undefined,unlimited?:boolean|number)=>unlimited?'不设限':String(value??0);

// Retain the finite draft so switching modes never reinterprets zero or loses input.
export function BudgetField({label,id,value,min,max,unlimited,disabled,onChange,onUnlimitedChange}:{
 label:string;id?:string;value:number;min:number;max:number;unlimited:boolean;disabled?:boolean;
 onChange:(value:number)=>void;onUnlimitedChange:(value:boolean)=>void;
}){
 const generated=useId(),inputId=id??generated;
 return <div className="budget-field"><div className="budget-field-heading"><label htmlFor={inputId}>{label}</label><Select id={inputId+'-mode'} aria-label={label+'预算方式'} value={unlimited?'unlimited':'limited'} disabled={disabled} onChange={e=>onUnlimitedChange(e.target.value==='unlimited')}><option value="limited">限额</option><option value="unlimited">不设限</option></Select></div><NumberField id={inputId} aria-label={label} min={min} max={max} value={unlimited?'':value} placeholder={unlimited?'不设限':undefined} disabled={disabled||unlimited} onChange={e=>onChange(Number(e.target.value))}/></div>;
}
