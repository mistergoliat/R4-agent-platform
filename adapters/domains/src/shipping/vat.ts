/**
 * VAT policy for customer-facing shipping amounts (R4-J2B decision).
 *
 * The Shipping owner (pc-carrier) prices in NET CLP and publishes no tax
 * metadata; customers are shown tax-included amounts. R4 therefore derives
 * the customer gross from the owner's net under this one explicit, versioned
 * policy, and keeps the owner net untouched next to it. J3 Quote may later
 * take authority over final commercial totals; the preserved net, rate and
 * policy id let it do so without trusting this derivation.
 *
 * The rate is applied as the exact fraction 119/100 with round-half-up, so
 * the result does not depend on the binary representation of 1.19.
 */
export const SHIPPING_VAT_POLICY = Object.freeze({
  id: 'cl-iva-19@r4-j2b',
  rate: 0.19,
  /** The rate as an exact fraction. */
  numerator: 119,
  denominator: 100,
} as const);

export type ShippingVatPolicyId = typeof SHIPPING_VAT_POLICY.id;

export interface DerivedShippingGross {
  readonly policy: ShippingVatPolicyId;
  readonly rate: number;
  readonly taxAmount: number;
  readonly grossAmount: number;
}

/**
 * Customer gross for an owner NET amount: round-half-up of net × 1.19, in
 * whole CLP. The net itself is never modified. Applies once: the input is
 * always the owner's net, never an amount this function produced.
 */
export function deriveShippingGross(ownerNet: number): DerivedShippingGross {
  if (!Number.isFinite(ownerNet) || ownerNet < 0) throw new RangeError('an owner net amount must be a finite, non-negative number');
  const grossAmount = Math.floor((ownerNet * SHIPPING_VAT_POLICY.numerator) / SHIPPING_VAT_POLICY.denominator + 0.5);
  return { policy: SHIPPING_VAT_POLICY.id, rate: SHIPPING_VAT_POLICY.rate, taxAmount: grossAmount - ownerNet, grossAmount };
}
