import site from './site.module.css';
import styles from './LegalPage.module.css';

/**
 * Long-form page with a table of contents: a sticky sidebar on desktop,
 * a plain list above the text on smaller screens.
 */
function LegalPage({ title, updated, intro, sections }) {
  return (
    <div className={`${site.container} ${styles.layout}`}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.updated}>Last updated {updated}</p>
        {intro && <div className={styles.intro}>{intro}</div>}
      </header>

      <nav className={styles.toc} aria-label="On this page">
        <p className={styles.tocHeading}>On this page</p>
        <ol>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ol>
      </nav>

      <div className={`${site.prose} ${styles.body}`}>
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={section.id}>
            <h2 id={section.id}>{section.title}</h2>
            {section.content}
          </section>
        ))}
      </div>
    </div>
  );
}

export default LegalPage;
