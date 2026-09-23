import type { Customer } from "../generated/customer";

export function invoicePartition(customer: Customer): string {
  return `${customer.taxRegion}:${customer.id}`;
}
