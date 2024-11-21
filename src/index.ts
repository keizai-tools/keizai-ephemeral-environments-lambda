import {
  ECSClient,
  StopTaskCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  CloudWatchEventsClient,
  DeleteRuleCommand,
  RemoveTargetsCommand,
} from "@aws-sdk/client-cloudwatch-events";

export const handler = async (event: {
  clientId: string;
  ruleName: string;
}) => {
  if (!event.clientId || !event.ruleName) {
    throw new Error("clientId and ruleName are required in the event object.");
  }

  const ecsClient = new ECSClient({ region: process.env.AWS_REGION });
  const eventsClient = new CloudWatchEventsClient({
    region: process.env.AWS_REGION,
  });
  const { clientId, ruleName } = event;
  const cluster = process.env.FARGATE_CLUSTER;

  try {
    const { taskArns } = await ecsClient.send(
      new ListTasksCommand({
        cluster,
        startedBy: clientId,
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
      console.log(`Stopped Fargate tasks: ${taskArns.join(", ")}`);
    } else {
      console.log(`No tasks found for clientId: ${clientId}`);
    }

    await eventsClient.send(
      new RemoveTargetsCommand({ Rule: ruleName, Ids: [`${clientId}-target`] })
    );
    await eventsClient.send(new DeleteRuleCommand({ Name: ruleName }));
    console.log(`Auto-stop rule deleted: ${ruleName}`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error stopping tasks or deleting rule: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${error}`);
    }
    throw error;
  }
};
