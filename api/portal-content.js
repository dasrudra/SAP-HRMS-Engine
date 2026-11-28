/**
 * portal-content.js - the portal's written pages.
 * ===========================================================================
 *
 * CONFIG.PORTFOLIO and CONFIG.PARTNERS from src/Config.gs, which Index.html
 * hands to the browser as `window.__EAS_PORTFOLIO__` and
 * `window.__EAS_PARTNERS__` and the About and Customers pages draw from.
 *
 * WHY IN CODE RATHER THAN IN THE DATABASE, when the team directory went the
 * other way. Portal.html is explicit about the team: "this page shows
 * thirty-seven people's work email, extension and personal mobile number,
 * and this repository is public." None of that applies here. These are the
 * department's own three words and a list of plant codes - the same facts
 * that are on the slide deck this page was built from, written to be read
 * by anybody who can reach the portal. There is nobody to protect from them,
 * and nothing that changes between one month and the next.
 *
 * What a database WOULD buy is correcting a sentence without a deployment,
 * which is the argument the FAQ and the KPI document links both won. It
 * loses here on volume: three pillars and three zones, edited perhaps twice
 * a year, against a table, a migration, an editor screen and a second place
 * for the text to be wrong in.
 *
 * NO EMPLOYEE NAMES, NO ADDRESSES, NO EXTENSIONS. Whatever else changes
 * about this file, that does not. The repository is public.
 */


/**
 * The About page. CONFIG.PORTFOLIO.
 *
 * Three pillars, and the page's closing band is built from the same three
 * words - so it cannot end up naming a pillar that is no longer there.
 */
const PORTFOLIO = {
  intro: 'Enterprise Application Services runs the SAP and business ' +
         'applications behind 23 of Youngone\'s 37 plants in Bangladesh. ' +
         'We keep them stable, keep them talking to each other, and keep ' +
         'retiring the work that should no longer be done by hand.',
  pillars: [
    {
      word: 'Run',
      line: 'Keep applications stable and secure.',
      items: [
        'Provide Level 1-3 support for enterprise application (SAP S/4HANA).',
        'Troubleshoot and resolve application errors, incidents, and ' +
          'integration failures.',
        'Maintain documentation (configurations, User Manuals, SOPs).',
        'Ensure integration aligns with data governance and security ' +
          'standards.',
        'Control application change requests and align them with IT ' +
          'governance.',
        'Maintain version control and rollback plans.'
      ]
    },
    {
      word: 'Connect',
      line: 'Integrate systems and data for real-time business visibility.',
      items: [
        'Work closely with business users to understand process ' +
          'requirements.',
        'Translate business needs into system requirements (functional ' +
          'specifications).',
        'Develop and maintain dashboards and BI reports (Power BI, Google ' +
          'Scripting etc.).',
        'Ensure data accuracy and consistency across all YO BD Entities.'
      ]
    },
    {
      word: 'Improve',
      line: 'Optimize processes and drive digital innovation.',
      items: [
        'Support process automation, digital workflows, and paperless ' +
          'initiatives.',
        'Provide end-user training for new systems, updates, and best ' +
          'practices.',
        'Conduct regular knowledge-sharing sessions within EAS team.',
        'Identify opportunities for automation (RPA, workflow tools).'
      ]
    }
  ]
};


/**
 * The Customers page. CONFIG.PARTNERS.
 *
 * THE PLANT COUNT IS NOT WRITTEN DOWN. renderPartners adds the lists up,
 * for the reason Config.gs gives about TVL: "Left off this list, the page
 * said 22 and the team supports 23." A number beside a list goes wrong the
 * first time somebody adds to the list and does not look up.
 */
const PARTNERS = {
  vendor: 'Tekvision (BD) Ltd',
  vendorShort: 'TVL',
  intro: 'The Youngone companies running SAP S/4HANA across Bangladesh\'s ' +
         'three export processing zones - and Tekvision itself.',
  zones: [
    {
      code: 'CEPZ',
      name: 'Chattogram Export Processing Zone',
      plants: ['YCL', 'KSL', 'TSL', 'YPL', 'YGA', 'SEL']
    },
    {
      code: 'KEPZ',
      name: 'Karnaphuli Export Processing Zone',
      /*
        TVL is Tekvision's own plant, in KEPZ, and it runs on the same
        S/4HANA that EAS keeps up for the rest of them. Left off this list,
        the page said 22 and the team supports 23.
      */
      plants: ['KSI-GMT', 'KSI-Shoe', 'KSI-BP', 'KSI-VXP', 'KSI-SWT',
               'KSI-OS', 'KSI-WS', 'KPP1', 'KPP2', 'KPP3', 'KPP4', 'KPL',
               'TVL']
    },
    {
      code: 'DEPZ',
      name: 'Dhaka Export Processing Zone',
      plants: ['YHT', 'SDF', 'YSF', 'STL']
    }
  ]
};


/** How many plants the Customers page will count. For the suite to check. */
function plantCount() {
  return PARTNERS.zones.reduce(function (n, zone) {
    return n + (zone.plants || []).length;
  }, 0);
}


module.exports = { PORTFOLIO, PARTNERS, plantCount };
