import { ShieldCheck, Database, Server } from "lucide-react";

const sections = [
  { title: "Authentication", icon: ShieldCheck, description: "Administrator credentials and access controls." },
  { title: "Database", icon: Database, description: "Database connections and backup configuration." },
  { title: "API & webhooks", icon: Server, description: "Integration credentials and webhook configuration." },
];

export default function Settings() {
  return (
    <section className="workspace-settings">
      <div className="workspace-page-heading"><h1>Settings</h1></div>
      <p className="workspace-source-note">These settings are managed outside this page.</p>
      <dl className="workspace-settings-list">
        {sections.map(({ title, icon: Icon, description }) => (
          <div key={title}>
            <dt><Icon size={20} aria-hidden="true" />{title}</dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
