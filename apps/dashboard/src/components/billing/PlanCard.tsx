import { Check } from 'lucide-react';

import type { Plan } from '../../hooks/usePricingPlans';
import {
  RECOMMENDED_PLAN_ID,
  formatPlanPrice,
  planCredits,
  planInclusions,
  pricePerCredit,
} from '../../lib/billing';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

interface PlanCardProps {
  plan: Plan;
  onBuy: (plan: Plan) => void;
  /** This plan's checkout is being opened or is open. */
  buying: boolean;
  /** Another plan's checkout is in progress, so this one waits. */
  disabled: boolean;
}

/** One plan: price, what it includes, and its own Buy button and busy state. */
export function PlanCard({ plan, onBuy, buying, disabled }: PlanCardProps) {
  const recommended = plan.id === RECOMMENDED_PLAN_ID;
  const perCredit = pricePerCredit(plan);
  const inclusions = planInclusions(plan);
  return (
    <Card
      className={cn(
        'flex flex-col justify-between transition-shadow hover:shadow-elevated',
        recommended && 'ring-2 ring-primary/30',
      )}
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">{plan.name}</h3>
          {recommended ? <Badge tone="primary">Recommended</Badge> : null}
        </div>
        <p className="mt-1 text-sm text-muted">{plan.description}</p>
        <p className="mt-5 flex items-baseline gap-1.5">
          <span className="metric text-3xl font-semibold tracking-tight text-foreground">
            {formatPlanPrice(plan.pricePaise)}
          </span>
          <span className="text-sm text-muted">
            {planCredits(plan.id) === null ? 'one-time · 30 days' : 'one-time'}
          </span>
        </p>
        {perCredit !== null ? (
          <p className="metric mt-0.5 text-xs text-faint">{perCredit}</p>
        ) : null}
        {inclusions.length > 0 ? (
          <ul className="mt-4 space-y-1.5 text-sm text-muted">
            {inclusions.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Button
        variant={recommended ? 'primary' : 'secondary'}
        onClick={() => onBuy(plan)}
        loading={buying}
        disabled={disabled}
        className="mt-6 w-full"
        aria-label={`Buy ${plan.name}`}
      >
        {buying ? 'Opening checkout…' : 'Buy'}
      </Button>
    </Card>
  );
}
