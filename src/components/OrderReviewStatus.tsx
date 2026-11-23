import { focusOrderSection } from '../orderSectionFocus';
import { Building2, ChevronRight, Droplets, Layers3, Leaf, TriangleAlert } from 'lucide-react';
import type { Project } from '../data';
import { getOrderProgress, type OrderEnvironmentReview } from '../orderReview';
import './OrderReviewStatus.css';

const icons = { waterway: Droplets, soil: Layers3, species: Leaf, ms4: Building2 };

export function OrderLookupWarnings({ review }: { review: OrderEnvironmentReview }) {
  if (!review.siteWarnings.length) return null;
  return <div className="order-lookup-warning" role="note" aria-label="Lookup review">
    <strong><TriangleAlert size={16} aria-hidden="true" />Lookup review</strong>
    <ul>{review.siteWarnings.map(({ message, target }) => <li key={message}>
      {message} {target !== 'order-environment' && <button type="button" onClick={() => focusOrderSection(target)}>
        {target.endsWith('county') ? 'Review county' : 'Review coordinates'}
      </button>}
    </li>)}</ul>
  </div>;
}

export function OrderReviewStatus({ project, review }: { project: Project; review: OrderEnvironmentReview }) {
  const progress = getOrderProgress(project);
  return <div className="order-review-status">
    <h5>{progress.heading}</h5>
    <ol className="order-progress" aria-label="Order progress">
      {['Review', 'Generation', 'Package'].map((title, i) => <li key={title} aria-current={progress.stage === i ? 'step' : undefined}>
        <i aria-hidden="true" /><strong>{title}</strong><span>{progress.steps[i]}</span>
      </li>)}
    </ol>
    <div className="order-check-heading">
      <h5>Environmental checks</h5>
      <span>{review.checks.filter(check => check.successful).length} of {review.checks.length} complete or approved</span>
    </div>
    <p className="order-check-provenance">Lookup history for this order. Verify the results apply to the current site and field values.</p>
    {review.siteWarnings.length > 0 && <button type="button" className="order-site-warning-link" onClick={() => focusOrderSection('order-environment')}>
      <TriangleAlert size={15} aria-hidden="true" />Read the site lookup warning
    </button>}
    <ul className="order-check-list">
      {review.checks.map(check => {
        const Icon = icons[check.key];
        return <li key={check.key}><details className={project.environmentLookupStatus?.[check.key] === 'failed' ? 'check-failed' : check.resolved ? 'check-resolved' : 'check-unresolved'}>
          <summary>
            <Icon size={16} aria-hidden="true" /><strong>{check.name}</strong>
            <span>{check.label}</span><ChevronRight size={14} aria-hidden="true" />
          </summary>
          <div className="order-check-details">
            <p>{check.detail}</p>
            <button type="button" onClick={() => focusOrderSection(check.target)}>Review {check.name.toLowerCase()} field</button>
          </div>
        </details></li>;
      })}
    </ul>
  </div>;
}
