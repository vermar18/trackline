# Trackline

Trackline is a shared workspace for tracking features, fixes, bugs, and other project actions. Its Node.js 24 backend uses Prisma Client and Prisma Migrate with MySQL 8.4. The same application serves the web interface and the API.

## Prepare MySQL and create the super admin

Create a dedicated empty MySQL schema, such as `trackline`, on your existing AWS database or another MySQL server. A fresh Trackline schema has no sample tickets. Give the migration account permission to create and change tables in that schema. Use a restricted account with SELECT, INSERT, UPDATE and DELETE on the Trackline tables for the running app.

Use a connection URL in this format:

```text
mysql://USER:PASSWORD@HOST:3306/trackline
```

URL-encode special characters in the username or password. For a remote database use TLS. For Prisma migrations, append `?sslaccept=strict&sslcert=URL_ENCODED_CA_FILE_PATH` when a CA file is required, using an absolute path on the machine running the migration. For the Trackline runtime, an RDS endpoint uses the RDS CA bundle automatically. Other hosts use the system trust store or a custom CA supplied in `DATABASE_SSL_CA`.

Local commands load `DATABASE_URL` from the project's ignored `.env` file. A connection URL already set in the shell takes precedence, so you can use separate migration and runtime credentials as shown below.

From PowerShell on a machine that can connect to the database:

```powershell
cd D:\RakeshProjects\ProjectTracker
npm ci
npm run db:generate

# Provide the migration account URL in this shell.
$dbUrl = Read-Host 'MySQL migration connection URL' -AsSecureString
try {
    $env:DATABASE_URL = [pscredential]::new('trackline', $dbUrl).GetNetworkCredential().Password
    npm run db:deploy
    if ($LASTEXITCODE) { throw 'Prisma migration failed.' }
} finally {
    $dbUrl.Dispose()
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
}

# Use the restricted runtime account URL to initialize the admin and run locally.
$dbUrl = Read-Host 'MySQL runtime connection URL' -AsSecureString
$env:DATABASE_URL = [pscredential]::new('trackline', $dbUrl).GetNetworkCredential().Password
$dbUrl.Dispose()
$env:TRACKLINE_ADMIN_USERNAME = Read-Host 'Super admin username'
$env:TRACKLINE_ADMIN_NAME = Read-Host 'Display name'
$adminPassword = Read-Host 'Super admin password (12–128 characters)' -AsSecureString
try {
    $env:TRACKLINE_ADMIN_PASSWORD = [pscredential]::new('trackline', $adminPassword).GetNetworkCredential().Password
    npm run init-admin
    if ($LASTEXITCODE) { throw 'Super admin initialization failed.' }
} finally {
    $adminPassword.Dispose()
    Remove-Item Env:TRACKLINE_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Remove `Env:DATABASE_URL` from the shell when finished. Admin initialization runs once per database.

If a MySQL schema already contains real Trackline data from the earlier version, back it up and compare its tables with the initial migration before baselining. If they match, record the migration with `npx prisma migrate resolve --applied 20261116000100_initial`, then use `npm run db:deploy` for future migrations. Existing unrelated databases should use a dedicated new schema. Prisma Migrate does not copy data from a different database.

`npm run build` generates Prisma Client and checks the app. `npm test` runs the standalone tests. To also run the integration tests, set `MYSQL_TEST=1` and provide `DATABASE_URL` for a disposable MySQL server. The tests create and delete randomly named schemas.

## Add team accounts

1. In the sidebar, select **Team members** and enter a display name, username, and unique temporary password for each teammate.
2. Share the workspace URL and username with the teammate. Give them the temporary password through a private channel. They must replace it before they can see or update work.
3. To help someone regain access, use **Reset password** in their account row. A reset signs them out of their existing sessions.

Only the super admin can manage accounts. Members can view and update all projects and their usernames appear in item history.

## Create projects and move incidents

Select the **+** beside **Projects** as super admin to add an option to the **Project** dropdown. The migration registers projects from existing work items. For CSV import, create any additional projects before uploading the file.

On **Board**, drag a card into the destination column, or use its **Move to…** dropdown with a keyboard or touch screen. Moving a card records a status change in its activity. Moving to **Done** opens the item for a resolution when one is missing.

## What the workflow needs

| Where the spreadsheet breaks down | How Trackline handles it |
| --- | --- |
| An action has no clear owner or next step | A work item groups its project, type, assignee, priority, due date, and current status under a stable ID. Items without an assignee appear in Needs attention. |
| Updates get lost during handoffs | An item carries its own discussion and time-stamped work logs. Changes record the author and previous and new values. Activity shows the latest 100 events across the workspace. |
| Old issues go unnoticed | Overview surfaces overdue, blocked, unassigned, and stale work. A seven-day gap in updates marks an open item stale. Click a metric to see the matching items. |
| A fix is marked done without recording the outcome | Done requires a resolution. Record what changed and how you verified it. Reopening preserves the earlier discussion and changes. |
| Review meetings require rebuilding the spreadsheet view | All work and Board offer search and filters for project, status, type, priority, and owner. The board groups items by status. CSV export follows the current filters. |
| Existing work is stranded in Excel | Import a UTF-8 CSV with a header row. Validation reports the first bad record and rejects the entire batch so corrections can be made safely. |

## Move the existing Excel tracker

1. In Trackline, select **Import from CSV** and download the template.
2. Map your worksheet columns to the template and save as **CSV UTF-8 (Comma delimited)**. Title and Project are required. Due dates use `YYYY-MM-DD`.
3. Normalize statuses to To do, In progress, Blocked, In review, or Done. Provide a resolution for Done items. Copy historical summaries into Description or Resolution. CSV import creates new items on each run, so check the file before importing it again.

Ongoing discussions and work logs go in an item's **Discussion & activity** panel. The filtered CSV export covers work-item fields. The database backup preserves the complete timeline.

## Deploy to Amplify Hosting

Trackline uses one Amplify Hosting compute deployment for the dashboard and the Node API. Prisma connects from that backend to your MySQL host over TCP with TLS. No separate Lambda function or API Gateway is provisioned.

1. **Check database reachability.** The MySQL host and port must be reachable from the Amplify runtime. A private-only RDS endpoint in an isolated VPC cannot be reached by adding an IAM role or a connection URL. Keep an isolated database private. For that case, run the same Trackline server on a host on its network, or use an approved TLS endpoint that Amplify can reach. For another MySQL provider, check its firewall and TLS requirements.
2. **Prepare the schema and admin.** Follow the Prisma migration and admin steps above from a machine with database access. Apply future migrations from that machine. The Amplify build generates the client and deploys code without modifying your database.
3. **Store the runtime connection URL.** Create one AWS Secrets Manager secret with JSON keys `DATABASE_URL` and, if needed, `DATABASE_CA_PEM` containing the trusted CA certificate in PEM format. Use the restricted runtime user. Give the Amplify **SSR compute role** permission to read that one secret with `secretsmanager:GetSecretValue`. AWS-managed secret encryption requires no additional KMS policy on the role. For a customer-managed KMS key, allow the role to decrypt with that key.
4. **Deploy the repository.** Connect a Git repository with Trackline at its root and use the included `amplify.yml` and Amplify web compute hosting. Set `TRACKLINE_ORIGIN` to your exact Amplify HTTPS URL, with no trailing slash, and `TRACKLINE_DATABASE_SECRET_ARN` to the secret ARN. The build bundles only the URL of the app and secret ARN. The server reads the MySQL credentials at runtime.
5. **Share the Amplify URL.** Sign in with the super admin, create team accounts, and verify a member can sign in and update a ticket.

If your existing Amplify app is configured for static hosting, switch its platform to `WEB_COMPUTE` before redeploying. See [AWS's custom Node server deployment example](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-express-server.html) and [SSR compute role setup](https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html).

## Scope and next decisions

This version focuses on ownership, item history, resolutions, and dashboard follow-up. The remaining team decisions are who owns the shared host and backups, which workbook columns need mapping, and whether overdue alerts should be sent somewhere outside the dashboard. Attachments, scheduled alerts, and project-level permissions are outside the current implementation.

