import { FyersAuthCard } from './FyersAuthCard';
import { CardHeader } from './ui/Card';

/**
 * Central place for broker credentials used by dashboard features. New broker
 * login cards belong here rather than in the individual workflows that need
 * their market data.
 */
export function BrokerLoginsView() {
  return (
    <div className="space-y-5">
      <CardHeader
        title="Broker logins"
        description="Connect brokers once and reuse their server-side sessions across dashboard features."
      />

      <section aria-labelledby="fyers-heading" className="space-y-3">
        <h2 id="fyers-heading" className="text-sm font-semibold text-foreground">
          Fyers
        </h2>
        <FyersAuthCard />
      </section>
    </div>
  );
}
