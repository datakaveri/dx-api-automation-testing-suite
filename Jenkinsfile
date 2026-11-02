pipeline {
  environment {
    devRegistry = 'ghcr.io/datakaveri/iudx-qa-automation'
    registryUri = 'https://ghcr.io'
    registryCredential = 'datakaveri-ghcr'
    namespace = 'iudx-qa-automation'
    appUrl = 'https://v2.dev.iudx.io/qa-automation'
    basePath = '/qa-automation/'
    keycloakUrl = 'https://v2.dev.iudx.io/auth'
    keycloakRealm = 'iudx-v2'
    keycloakClientId = 'frontend-client'
    GIT_HASH = GIT_COMMIT.take(7)
  }

  agent {
    node {
      label 'slave1'
    }
  }

  triggers {
    pollSCM('H/5 * * * *')
  }

  options {
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  stages {

    stage('Unit Tests') {
      steps {
        script {
          sh '''
            docker run --rm -v "$WORKSPACE/backend":/src:ro node:22-slim \
              sh -c 'cp -r /src /app && cd /app && npm ci --no-audit --no-fund && npm test'
          '''
        }
      }
    }

    stage('Trivy Code Scan (Dependencies)') {
      steps {
        script {
          sh '''
            trivy fs --scanners vuln,secret,misconfig --output trivy-fs-report.txt .
          '''
        }
      }
    }

    stage('Building images') {
      steps {
        script {
          echo 'Pulled - ' + env.GIT_BRANCH
          backendImage = docker.build("${devRegistry}:backend-${env.GIT_HASH}", "./backend")
          frontendImage = docker.build(
            "${devRegistry}:frontend-${env.GIT_HASH}",
            "--build-arg BASE_PATH=${basePath} " +
            "--build-arg VITE_KEYCLOAK_URL=${keycloakUrl} " +
            "--build-arg VITE_KEYCLOAK_REALM=${keycloakRealm} " +
            "--build-arg VITE_KEYCLOAK_CLIENT_ID=${keycloakClientId} " +
            "--build-arg VITE_API_BASE_URL=${appUrl} " +
            "./frontend"
          )
        }
      }
    }

    stage('Trivy Scan and Report') {
      steps {
        script {
          sh "trivy image --output trivy-backend-image-report.txt ${backendImage.imageName()}"
          sh "trivy image --output trivy-frontend-image-report.txt ${frontendImage.imageName()}"
          catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE',
                     message: 'Trivy found fixable HIGH/CRITICAL vulnerabilities - see Trivy Reports') {
            sh """
            trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed ${backendImage.imageName()}
            trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed ${frontendImage.imageName()}
            """
          }
        }
      }
      post {
        always {
          archiveArtifacts artifacts: 'trivy-*.txt', allowEmptyArchive: true
          publishHTML(target: [
            allowMissing: true,
            keepAll: true,
            reportDir: '.',
            reportFiles: 'trivy-fs-report.txt, trivy-backend-image-report.txt, trivy-frontend-image-report.txt',
            reportName: 'Trivy Reports'
          ])
        }
      }
    }

    stage('Push Images') {
      steps {
        script {
          currentBuild.description = "backend-${env.GIT_HASH}, frontend-${env.GIT_HASH}"
          docker.withRegistry(registryUri, registryCredential) {
            backendImage.push()
            frontendImage.push()
          }
        }
      }
    }

    stage('EKS deployment') {
      steps {
        script {
          sh """
            ssh ubuntu@dev-eks '
              for app in backend frontend; do
                kubectl -n ${namespace} set image deployment/\$app \$app=${devRegistry}:\$app-${env.GIT_HASH} || exit 1
                kubectl -n ${namespace} rollout status deployment/\$app --timeout=5m || {
                  kubectl -n ${namespace} rollout undo deployment/\$app
                  exit 1
                }
              done
            '
          """
        }
      }
      post {
        failure {
          error "Failed to deploy images to EKS"
        }
      }
    }

    stage('Smoke Test') {
      steps {
        script {
          sh """
            sleep 5
            for path in / /health; do
              CODE=\$(curl -s -o /dev/null -m 20 -w '%{http_code}' "${appUrl}\$path")
              echo "GET ${appUrl}\$path -> \$CODE"
              [ "\$CODE" = 200 ] || { echo "Smoke test failed"; exit 1; }
            done
          """
        }
      }
    }

  }

  post {
    always {
      script {
        sh "docker rmi ${devRegistry}:backend-${env.GIT_HASH} ${devRegistry}:frontend-${env.GIT_HASH} || true"
      }
    }
  }
}
