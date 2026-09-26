def version=''

// Shared by both SSM stages: polls list-command-invocations until nothing is Pending/InProgress,
// then fails the build if any instance ended in a non-Success state.
def waitForSsmCommand(commandId, label) {
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
        error "${label} failed on instances: ${failed}"
    }
}

pipeline {
    agent any

    environment {
        AWS_REGION      = 'ap-northeast-1'
        DEPLOY_BUCKET   = 'testing-node-app-142369633239'
        BUILD_VERSION   = "${env.BUILD_NUMBER}"
        VAULT_ADDR      = 'http://192.168.0.26:8200'
        // matches the name run.sh instance-ami (cd-stack-gen/project-11) derives from
        // ROLE=testing-node-app ENV_TYPE=production: "${ROLE}-${ENV_TYPE}"
        RESOURCE_GROUP_NAME = 'testing-node-app-production'
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
                sh "chmod +x build.sh"
                sh "./build.sh ${version}"
// 
                sh "echo $VAULT_ADDR"
            }
        }

        stage('Upload Artifact') {
            steps {
                withVault(
                    configuration: [
                        vaultUrl: "$VAULT_ADDR",
                        vaultCredentialId: 'vault-approle',
                        engineVersion: 1
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
                        aws sts get-caller-identity
                        aws ec2 describe-instances --region ap-northeast-1 --output json

                        aws s3 cp myapp-${version}.tar.gz \
                            s3://${DEPLOY_BUCKET}/myapp-${version}.tar.gz \
                            --region ap-northeast-1

                        aws s3 cp deploy.sh \
                            s3://${DEPLOY_BUCKET}/scripts/deploy.sh \
                            --region ap-northeast-1
                    """
                }
            }
        }

        stage('Push deploy.sh via SSM') {
            steps {
                withVault(
                    configuration: [
                        vaultUrl: "${VAULT_ADDR}",
                        vaultCredentialId: 'vault-approle',
                        engineVersion: 1
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
                        // each instance pulls the script itself via its own instance profile -
                        // Jenkins never needs to reach the instances directly for this
                        def pushCommandId = sh(
                            script: """
                              aws ssm send-command \
                                --document-name "AWS-RunShellScript" \
                                --targets "Key=resource-groups:Name,Values=${RESOURCE_GROUP_NAME}" \
                                --parameters commands=["mkdir -p /opt/scripts","aws s3 cp s3://${DEPLOY_BUCKET}/scripts/deploy.sh /opt/scripts/deploy.sh --region ${AWS_REGION}","chmod +x /opt/scripts/deploy.sh"] \
                                --output-s3-bucket-name my-deploy-logs-bucket \
                                --query 'Command.CommandId' --output text
                            """,
                            returnStdout: true
                        ).trim()

                        echo "Push deploy.sh SSM Command ID: ${pushCommandId}"
                        waitForSsmCommand(pushCommandId, "Pushing deploy.sh")
                    }
                }
            }
        }

        stage('Deploy via SSM') {
            steps {
                withVault(
                    configuration: [
                        vaultUrl: "${VAULT_ADDR}",
                        vaultCredentialId: 'vault-approle',
                        engineVersion: 1
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
                                --targets "Key=resource-groups:Name,Values=${RESOURCE_GROUP_NAME}" \
                                --parameters commands=["/opt/scripts/deploy.sh ${version}"] \
                                --output-s3-bucket-name my-deploy-logs-bucket \
                                --query 'Command.CommandId' --output text
                            """,
                            returnStdout: true
                        ).trim()

                        echo "SSM Command ID: ${commandId}"
                        waitForSsmCommand(commandId, "Deployment")
                    }
                }
            }
        }
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