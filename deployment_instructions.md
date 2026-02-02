# Deploying to Google Cloud Run

This document provides the steps to deploy the `lock-pc-server` application to Google Cloud Run.

## Prerequisites

1.  **Google Cloud Project:** You need a Google Cloud project with the Cloud Build API and Cloud Run API enabled.
2.  **`gcloud` CLI:** You need to have the `gcloud` command-line tool installed and authenticated with your Google Cloud account.
3.  **Permissions:** You need to have the `roles/cloudbuild.builds.builder` and `roles/run.admin` roles in your Google Cloud project.

## Deployment Steps

1.  **Enable APIs:**

    Open the Cloud Shell in your Google Cloud project and run the following commands to enable the necessary APIs:

    ```bash
    gcloud services enable run.googleapis.com
    gcloud services enable cloudbuild.googleapis.com
    ```

2.  **Set your project ID:**

    In the Cloud Shell, set your project ID as an environment variable. Replace `[YOUR_PROJECT_ID]` with your actual project ID.

    ```bash
    export PROJECT_ID=[YOUR_PROJECT_ID]
    ```

3.  **Run the build:**

    In your local project directory (the same directory as the `cloudbuild.yaml` file), run the following command to start the Cloud Build process. This command will build the Docker image, push it to the Google Container Registry, and deploy it to Cloud Run.

    ```bash
    gcloud builds submit --config cloudbuild.yaml .
    ```

4.  **Access your application:**

    Once the deployment is complete, the `gcloud` command will output the URL of your deployed application. You can use this URL to access the `lock-pc-server`.

## Important Notes

*   The `cloudbuild.yaml` file is configured to deploy the service to the `us-central1` region. You can change this to a different region if you prefer.
*   The `--allow-unauthenticated` flag is used in the `cloudbuild.yaml` file to make the service publicly accessible. If you want to restrict access to your service, you can remove this flag and configure IAM to control access.
*   This deployment uses the `bcrypt` library, which has native dependencies. The `gcp-build` script in `package.json` and the `Dockerfile` are configured to handle these native dependencies correctly.
*   The SQLite database (`server.db`) is not suitable for a stateless environment like Cloud Run, as the file system is ephemeral. For a production deployment, you should use a managed database service like Google Cloud SQL. The current setup will work for a demo, but the database will be reset with every new instance.
