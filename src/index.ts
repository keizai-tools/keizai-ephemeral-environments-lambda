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
  ListTargetsByRuleCommand,
  type RemovePermissionCommandOutput,
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
    ACCESS_KEY: accessKeyId,
    SECRET_KEY: secretAccessKey,
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
      new ListTasksCommand({ cluster, startedBy: taskID })
    );

    if (taskArns?.length) {
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

    const { Targets: targets } = await eventsClient.send(
      new ListTargetsByRuleCommand({ Rule: taskID })
    );

    if (targets?.length) {
      await eventsClient.send(
        new RemoveTargetsCommand({
          Rule: taskID,
          Ids: targets.map((target) => target.Id!).filter(Boolean),
        })
      );
    }

    await eventsClient.send(new DeleteRuleCommand({ Name: taskID }));

    const removePermissionSafely = async (
      command: () => Promise<RemovePermissionCommandOutput>,
      errorMessage: string
    ) => {
      try {
        await command();
      } catch (error) {
        if ((error as Error).name !== "ResourceNotFoundException") {
          throw error;
        }
        console.warn(errorMessage);
      }
    };

    await removePermissionSafely(
      () =>
        eventsClient.send(new RemovePermissionCommand({ StatementId: taskID })),
      `EventBus does not have a policy for StatementId: ${taskID}`
    );

    await removePermissionSafely(
      () =>
        lambdaClient.send(
          new LambdaRemovePermissionCommand({
            FunctionName: lambdaArn,
            StatementId: taskID,
          })
        ),
      `Lambda does not have a policy for StatementId: ${taskID}`
    );

    await removePermissionSafely(
      () =>
        eventsClient.send(
          new RemoveTargetsCommand({
            Rule: taskID,
            Ids: [taskID],
          })
        ),
      `Failed to remove trigger for Rule: ${taskID}`
    );

    console.log(
      `Successfully cleaned up resources and trigger for taskID: ${taskID}`
    );
  } catch (error) {
    console.error(
      `Error occurred during cleanup operations: ${
        error instanceof Error ? error.message : error
      }`
    );
    throw error;
  }
}
