def version=''
pipeline {
    agent any

    environment {
        AWS_REGION      = 'ap-northeast-1'
        DEPLOY_BUCKET   = 'my-deploy-bucket'
        BUILD_VERSION   = "${env.BUILD_NUMBER}"
        VAULT_ADDR      = 'http://192.168.0.26:8200'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    def commitHash = sh(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()

                    version = "${env.BUILD_NUMBER}-${commitHash}"
                    echo "version: ${version}"
            }
            }
        }

        stage('Build') {
            steps {
                sh "./build.sh ${version}"
            }
        }

        /* stage('Upload Artifact') {
            steps {
                withVault(
                    configuration: [
                        vaultUrl: "${VAULT_ADDR}",
                        vaultCredentialId: 'vault-approle',
                        engineVersion: 2
                    ],
                    vaultSecrets: [
                        [
                            path: 'aws/creds/deploy-s3-role',
                            secretValues: [
                                [envVar: 'AWS_ACCESS_KEY_ID', vaultKey: 'access_key'],
                                [envVar: 'AWS_SECRET_ACCESS_KEY', vaultKey: 'secret_key'],
                                [envVar: 'AWS_SESSION_TOKEN', vaultKey: 'security_token']
                            ]
                        ]
                    ]
                ) {
                    sh """
                      aws s3 cp myapp-${BUILD_VERSION}.tar.gz \
                        s3://${DEPLOY_BUCKET}/myapp-${BUILD_VERSION}.tar.gz
                    """
                }
            }
        }

        stage('Deploy via SSM') {
            steps {
                withVault(
                    configuration: [
                        vaultUrl: "${VAULT_ADDR}",
                        vaultCredentialId: 'vault-approle',
                        engineVersion: 2
                    ],
                    vaultSecrets: [
                        [
                            path: 'aws/creds/deploy-ssm-role',
                            secretValues: [
                                [envVar: 'AWS_ACCESS_KEY_ID', vaultKey: 'access_key'],
                                [envVar: 'AWS_SECRET_ACCESS_KEY', vaultKey: 'secret_key'],
                                [envVar: 'AWS_SESSION_TOKEN', vaultKey: 'security_token']
                            ]
                        ]
                    ]
                ) {
                    script {
                        def commandId = sh(
                            script: """
                              aws ssm send-command \
                                --document-name "AWS-RunShellScript" \
                                --targets "Key=tag:Role,Values=app-server" "Key=tag:Environment,Values=production" \
                                --parameters commands=["/opt/scripts/deploy.sh ${BUILD_VERSION}"] \
                                --output-s3-bucket-name my-deploy-logs-bucket \
                                --query 'Command.CommandId' --output text
                            """,
                            returnStdout: true
                        ).trim()

                        echo "SSM Command ID: ${commandId}"

                        timeout(time: 5, unit: 'MINUTES') {
                            waitUntil {
                                def statuses = sh(
                                    script: """
                                      aws ssm list-command-invocations \
                                        --command-id ${commandId} \
                                        --query 'CommandInvocations[].Status' \
                                        --output text
                                    """,
                                    returnStdout: true
                                ).trim()

                                def stillRunning = statuses.split()
                                    .any { it == 'Pending' || it == 'InProgress' }

                                return !stillRunning
                            }
                        }

                        def failed = sh(
                            script: """
                              aws ssm list-command-invocations \
                                --command-id ${commandId} \
                                --query "CommandInvocations[?Status!='Success'].InstanceId" \
                                --output text
                            """,
                            returnStdout: true
                        ).trim()

                        if (failed) {
                            error "Deployment failed on instances: ${failed}"
                        }
                    }
                }
            }
        } */
    }

    post {
        failure {
            echo "Deployment failed — check SSM output in S3 (my-deploy-logs-bucket) or per-instance rollback status"
        }
        success {
            echo "Deployed version ${BUILD_VERSION} to all app-server instances"
        }
    }
}