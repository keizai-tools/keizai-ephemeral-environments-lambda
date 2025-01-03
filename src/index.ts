import {
  ECSClient,
  StopTaskCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  CloudWatchEventsClient,
  DeleteRuleCommand,
  RemoveTargetsCommand,
  RemovePermissionCommand,
} from "@aws-sdk/client-cloudwatch-events";
import {
  LambdaClient,
  RemovePermissionCommand as LambdaRemovePermissionCommand,
} from "@aws-sdk/client-lambda";

export async function handler({ taskID }: { taskID: string }) {
  if (!taskID) {
    console.error("Missing taskID in the event object.");
    throw new Error("taskID is required in the event object.");
  }

  const {
    AWS_ECS_ACCESS_KEY: accessKeyId,
    AWS_ECS_SECRET_KEY: secretAccessKey,
    AWS_REGION: region,
    FARGATE_CLUSTER: cluster,
    LAMBDA_ARN: lambdaArn,
  } = process.env;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS ECS credentials are not defined.");
  }

  const credentials = { accessKeyId, secretAccessKey };
  const ecsClient = new ECSClient({ region, credentials });
  const eventsClient = new CloudWatchEventsClient({ region, credentials });
  const lambdaClient = new LambdaClient({ region, credentials });

  try {
    const { taskArns } = await ecsClient.send(
      new ListTasksCommand({
        cluster,
        startedBy: taskID,
      })
    );

    if (taskArns && taskArns.length > 0) {
      await Promise.all(
        taskArns.map((taskArn) =>
          ecsClient.send(
            new StopTaskCommand({
              cluster,
              task: taskArn,
              reason: "Auto-stop rule triggered",
            })
          )
        )
      );
    } else {
      console.warn(`No tasks found for taskID: ${taskID}`);
    }

    await eventsClient.send(
      new RemoveTargetsCommand({ Rule: taskID, Ids: [taskID] })
    );
    await eventsClient.send(new DeleteRuleCommand({ Name: taskID }));
    await eventsClient.send(
      new RemovePermissionCommand({
        StatementId: taskID,
      })
    );
    await lambdaClient.send(
      new LambdaRemovePermissionCommand({
        FunctionName: lambdaArn,
        StatementId: taskID,
      })
    );
  } catch (error) {
    console.error(
      `Error occurred during ECS or CloudWatch operations: ${
        error instanceof Error ? error.message : error
      }`
    );
    throw error;
  }
}
