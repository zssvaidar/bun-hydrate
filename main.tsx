import React, { Suspense, useEffect, useState } from "react";
import { Button } from "./src/app/packages/core/button/button";
import Content from "./src/app/Content";



const DemoComponent = () => {
  // StaticRouterProvider
  const LazyButton = React.lazy(async () => {
    await new Promise(resolve => setTimeout(resolve, 2000));

    return {
      default: Button,
    }
  });

  useEffect(() => {
    console.log('mounted');
  }, []);

  return (
    <div>
      <Suspense fallback={<>Waitttt</>}>
        <LazyButton onClick={() => alert('clicked')} />
      </Suspense>
    </div>
  );
}

export class App extends React.Component{

  render () {
    return (
        <React.StrictMode>
          <html lang="en">
            <head>
              <meta charSet="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>Document</title>
            </head>
            <body>
              <h1>Hello, world</h1>
              <a href={`/page/1`}>Page One Link</a>
              <Content />
              <Button onClick={() => alert('clicked')} />
              <DemoComponent />
            </body>
          </html>
        </React.StrictMode>
      );
  }
};
